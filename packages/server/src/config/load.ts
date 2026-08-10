import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { ConfigError } from '../core/errors.js';
import { getProvider, providerTypes } from '../providers/index.js';
import type { ResolvedService } from '../providers/types.js';
import type { PortInfo, UrlInfo } from '../types.js';
import {
  configFileSchema,
  serviceFileSchema,
  type GroupDefinition,
  type ServiceBase,
  type Settings,
} from './schema.js';

/** A service definition that is switched off via `enabled: false`. */
export interface DisabledService {
  id: string;
  name: string;
  type: string;
  group: string;
  source: string;
}

export interface LoadedConfig {
  path: string;
  /** Directories that were scanned for per-service files. */
  serviceDirs: string[];
  settings: Settings;
  groups: GroupDefinition[];
  services: ResolvedService[];
  disabled: DisabledService[];
  /** Non-fatal problems worth showing in the UI. */
  warnings: string[];
}

/** Default per-service directory, relative to the main config file. */
const DEFAULT_SERVICE_DIR = 'services.d';

/** Search order for the config file when no explicit path is given. */
export function candidatePaths(): string[] {
  const fromEnv = process.env.SWITCHYARD_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config');
  return [
    ...(fromEnv ? [fromEnv] : []),
    resolve(process.cwd(), 'switchyard.yaml'),
    resolve(process.cwd(), 'switchyard.yml'),
    resolve(xdg, 'switchyard/switchyard.yaml'),
    '/etc/switchyard/switchyard.yaml',
  ];
}

export function resolveConfigPath(explicit?: string): string {
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
    return path;
  }
  for (const candidate of candidatePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ConfigError('no switchyard.yaml found', [
    'looked in:',
    ...candidatePaths().map((path) => `  ${path}`),
    'pass --config <path> or set SWITCHYARD_CONFIG',
  ]);
}

/** One service definition plus the file it came from. */
interface SourcedDefinition {
  definition: ServiceBase;
  source: string;
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const path = resolveConfigPath(explicitPath);
  const configDir = dirname(path);

  const base = configFileSchema.safeParse(await readYaml(path));
  if (!base.success) {
    throw new ConfigError(`invalid configuration in ${path}`, formatIssues(base.error));
  }

  const warnings: string[] = [];
  const issues: string[] = [];

  // Main file first, then each services directory in declaration order.
  const definitions: SourcedDefinition[] = base.data.services.map((definition) => ({
    definition,
    source: path,
  }));

  const serviceDirs = resolveServiceDirs(base.data.serviceDirs, configDir, warnings);
  for (const dir of serviceDirs) {
    definitions.push(...(await readServiceDir(dir, issues)));
  }

  const services: ResolvedService[] = [];
  const disabled: DisabledService[] = [];
  const seen = new Map<string, string>();

  for (const { definition, source } of definitions) {
    const where = `${relativeTo(configDir, source)} (${definition.id})`;

    const previous = seen.get(definition.id);
    if (previous) {
      issues.push(`${where}: duplicate service id, already defined in ${relativeTo(configDir, previous)}`);
      continue;
    }
    seen.set(definition.id, source);

    if (!definition.enabled) {
      disabled.push({
        id: definition.id,
        name: definition.name,
        type: definition.type,
        group: definition.group,
        source,
      });
      continue;
    }

    const provider = getProvider(definition.type);
    if (!provider) {
      issues.push(`${where}: unknown provider type "${definition.type}" (known: ${providerTypes().join(', ')})`);
      continue;
    }

    const providerParsed = provider.configSchema.safeParse(definition.provider ?? {});
    if (!providerParsed.success) {
      for (const line of formatIssues(providerParsed.error)) {
        issues.push(`${where}: provider.${line}`);
      }
      continue;
    }

    // Relative workdirs resolve against the file that declared the service, so a
    // services.d entry can point at a sibling directory.
    const workdir = definition.workdir
      ? isAbsolute(definition.workdir)
        ? definition.workdir
        : resolve(dirname(source), definition.workdir)
      : undefined;

    if (workdir && !existsSync(workdir)) {
      warnings.push(`${definition.id}: workdir does not exist: ${workdir}`);
    }

    services.push({
      ...definition,
      workdir,
      ports: definition.ports.map(normalisePort),
      urls: definition.urls.map(normaliseUrl),
      provider: providerParsed.data,
      timeout: definition.timeoutMs ?? base.data.settings.commandTimeoutMs,
      source,
    });
  }

  if (issues.length > 0) {
    throw new ConfigError(`invalid configuration in ${relativeTo(configDir, path)}`, issues);
  }

  const groups = withDefaultGroups(base.data.groups, services);
  for (const service of services) {
    if (!base.data.groups.some((group) => group.id === service.group)) {
      warnings.push(`${service.id}: group "${service.group}" is not declared under groups:`);
    }
  }

  if (services.length === 0) {
    warnings.push(
      disabled.length > 0
        ? `no enabled services (${disabled.length} disabled via enabled: false)`
        : 'no services configured',
    );
  }

  return { path, serviceDirs, settings: base.data.settings, groups, services, disabled, warnings };
}

async function readYaml(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`);
  }

  let document: unknown;
  try {
    document = yaml.load(raw, { filename: path });
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${path}`, [(error as Error).message]);
  }

  if (document === null || document === undefined) {
    throw new ConfigError(`${path} is empty`);
  }
  return document;
}

function resolveServiceDirs(
  declared: string[] | undefined,
  configDir: string,
  warnings: string[],
): string[] {
  if (declared === undefined) {
    const fallback = resolve(configDir, DEFAULT_SERVICE_DIR);
    return isDirectory(fallback) ? [fallback] : [];
  }

  const dirs: string[] = [];
  for (const entry of declared) {
    const dir = isAbsolute(entry) ? entry : resolve(configDir, entry);
    if (!isDirectory(dir)) {
      warnings.push(`serviceDirs: not a directory, skipped: ${dir}`);
      continue;
    }
    dirs.push(dir);
  }
  return dirs;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads every `*.yaml` / `*.yml` file in a directory, sorted by name so the load
 * order is stable and predictable. Files may hold a single service or a
 * `services:` list. Subdirectories are ignored, which makes them a convenient
 * place to park definitions you are not using.
 */
async function readServiceDir(dir: string, issues: string[]): Promise<SourcedDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    issues.push(`cannot read services directory ${dir}: ${(error as Error).message}`);
    return [];
  }

  const files = entries
    .filter((entry) => /\.(ya?ml)$/i.test(entry))
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => resolve(dir, entry))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });

  const found: SourcedDefinition[] = [];
  for (const file of files) {
    let document: unknown;
    try {
      document = await readYaml(file);
    } catch (error) {
      issues.push((error as ConfigError).format?.() ?? (error as Error).message);
      continue;
    }

    const parsed = serviceFileSchema.safeParse(document);
    if (!parsed.success) {
      for (const line of formatIssues(parsed.error)) {
        issues.push(`${basename(file)}: ${line}`);
      }
      continue;
    }

    const definitions = 'services' in parsed.data ? parsed.data.services : [parsed.data];
    for (const definition of definitions) {
      found.push({ definition, source: file });
    }
  }
  return found;
}

/**
 * Groups referenced by services but not declared get a generated definition, so
 * a minimal config file stays valid.
 */
function withDefaultGroups(declared: GroupDefinition[], services: ResolvedService[]): GroupDefinition[] {
  const groups = [...declared];
  const known = new Set(groups.map((group) => group.id));
  for (const service of services) {
    if (!known.has(service.group)) {
      known.add(service.group);
      groups.push({ id: service.group, name: titleCase(service.group), order: 900 });
    }
  }
  return groups.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.name.localeCompare(b.name));
}

function titleCase(value: string): string {
  return value
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Paths in messages stay short when they sit under the config directory. */
function relativeTo(configDir: string, path: string): string {
  return path.startsWith(`${configDir}/`) ? path.slice(configDir.length + 1) : path;
}

function normalisePort(port: number | { port: number; protocol: 'tcp' | 'udp'; label?: string; url?: string }): PortInfo {
  if (typeof port === 'number') return { port, protocol: 'tcp' };
  return port;
}

function normaliseUrl(url: string | { label: string; url: string; primary?: boolean }): UrlInfo {
  if (typeof url === 'string') return { label: shortUrlLabel(url), url, primary: true };
  return url;
}

function shortUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
