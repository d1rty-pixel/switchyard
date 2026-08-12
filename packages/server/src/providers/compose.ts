import { z } from 'zod';
import { failureReason, firstMeaningfulLine, toCommandOutput } from '../core/exec.js';
import type {
  ActionDescriptor,
  ActionOutcome,
  ChildStatus,
  LogsResult,
  Metric,
  PortInfo,
  ServiceState,
  StatusResult,
  UrlInfo,
} from '../types.js';
import { splitLines, type Provider, type ProviderContext } from './types.js';

/**
 * Docker Compose provider.
 *
 * A stack is not reduced to running/stopped: the provider reports per-container
 * state, health, published ports and exit codes, and derives an aggregate state
 * that distinguishes "partially up" (degraded) from "up" and "down".
 */

const COMPOSE_ACTIONS = [
  'up',
  'down',
  'restart',
  'stop',
  'start',
  'pull',
  'build',
  'recreate',
  'destroy',
] as const;
type ComposeAction = (typeof COMPOSE_ACTIONS)[number];

const composeConfigSchema = z
  .object({
    /** One or more compose files. Relative paths resolve against `projectDir`. */
    files: z.array(z.string().min(1)).default([]),
    /** Convenience alias for a single compose file. */
    file: z.string().min(1).optional(),
    /** Directory the compose commands run in; defaults to the service workdir. */
    projectDir: z.string().optional(),
    projectName: z.string().min(1).optional(),
    dockerPath: z.string().default('docker'),
    /** `--env-file` passed to compose. */
    envFile: z.string().optional(),
    /** Extra compose-level flags from config, e.g. ["--profile", "dev"]. */
    composeArgs: z.array(z.string().min(1)).default([]),
    actions: z.array(z.enum(COMPOSE_ACTIONS)).default(['up', 'down', 'restart', 'pull']),
    /** Timeout for long-running actions (up/pull/build/down). */
    slowTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(600_000),
    /** Treat containers without a healthcheck as healthy (default) or unknown. */
    requireHealthchecks: z.boolean().default(false),
  })
  .strict();

export type ComposeConfig = z.infer<typeof composeConfigSchema>;

const ACTION_META: Record<
  ComposeAction,
  {
    label: string;
    kind: ActionDescriptor['kind'];
    icon: string;
    args: string[];
    slow?: boolean;
    confirm?: boolean;
    enabledIn?: ServiceState[];
    description: string;
  }
> = {
  up: {
    label: 'Up',
    kind: 'primary',
    icon: 'play',
    args: ['up', '-d', '--remove-orphans'],
    slow: true,
    enabledIn: ['stopped', 'failed', 'degraded', 'unknown'],
    description: 'docker compose up -d --remove-orphans',
  },
  down: {
    label: 'Down',
    kind: 'danger',
    icon: 'square',
    args: ['down', '--remove-orphans'],
    slow: true,
    confirm: true,
    enabledIn: ['running', 'degraded', 'starting', 'failed'],
    description: 'docker compose down --remove-orphans',
  },
  restart: { label: 'Restart', kind: 'secondary', icon: 'rotate-cw', args: ['restart'], description: 'docker compose restart' },
  stop: {
    label: 'Stop',
    kind: 'secondary',
    icon: 'pause',
    args: ['stop'],
    enabledIn: ['running', 'degraded'],
    description: 'docker compose stop (keeps containers)',
  },
  start: {
    label: 'Start',
    kind: 'secondary',
    icon: 'play',
    args: ['start'],
    enabledIn: ['stopped', 'degraded'],
    description: 'docker compose start (existing containers only)',
  },
  pull: { label: 'Pull images', kind: 'utility', icon: 'download', args: ['pull'], slow: true, description: 'docker compose pull' },
  build: { label: 'Build', kind: 'utility', icon: 'hammer', args: ['build'], slow: true, description: 'docker compose build' },
  recreate: {
    label: 'Recreate',
    kind: 'secondary',
    icon: 'refresh-cw',
    args: ['up', '-d', '--force-recreate', '--remove-orphans'],
    slow: true,
    confirm: true,
    description: 'docker compose up -d --force-recreate',
  },
  destroy: {
    label: 'Down + volumes',
    kind: 'danger',
    icon: 'trash-2',
    args: ['down', '-v', '--remove-orphans'],
    slow: true,
    confirm: true,
    description: 'docker compose down -v — deletes named volumes',
  },
};

/** `docker compose config --services` is slow; cache the service list. */
const SERVICE_LIST_TTL_MS = 120_000;
const serviceListCache = new Map<string, { at: number; services: string[] }>();

function composeBaseArgv(config: ComposeConfig): string[] {
  const files = [...(config.file ? [config.file] : []), ...config.files];
  return [
    config.dockerPath,
    'compose',
    ...files.flatMap((file) => ['-f', file]),
    ...(config.projectName ? ['-p', config.projectName] : []),
    ...(config.envFile ? ['--env-file', config.envFile] : []),
    ...config.composeArgs,
  ];
}

function projectCwd(context: ProviderContext<ComposeConfig>): string | undefined {
  return context.config.projectDir ?? context.service.workdir;
}

interface ComposePs {
  ID?: string;
  Name?: string;
  Image?: string;
  Service?: string;
  State?: string;
  Status?: string;
  Health?: string;
  ExitCode?: number;
  Created?: number;
  Publishers?: { URL?: string; TargetPort?: number; PublishedPort?: number; Protocol?: string }[] | null;
}

export const composeProvider: Provider<ComposeConfig> = {
  type: 'compose',
  label: 'Docker Compose',
  description: 'A Docker Compose project, reported per container.',
  configSchema: composeConfigSchema,

  actions({ config }) {
    return config.actions.map((id): ActionDescriptor => {
      const meta = ACTION_META[id];
      return {
        id,
        label: meta.label,
        kind: meta.kind,
        icon: meta.icon,
        description: meta.description,
        confirm: meta.confirm ?? false,
        slow: meta.slow ?? false,
        enabledIn: meta.enabledIn,
      };
    });
  },

  supportsLogs() {
    return true;
  },

  async status(context): Promise<StatusResult> {
    const { config } = context;
    const cwd = projectCwd(context);

    const psResult = await context.execRaw({
      argv: [...composeBaseArgv(config), 'ps', '-a', '--format', 'json'],
      cwd,
      env: context.service.env,
      timeoutMs: context.service.timeout,
      label: `${context.service.id}:status`,
    });

    if (psResult.spawnError) {
      return {
        state: 'unknown',
        summary: psResult.spawnError.message,
        detail: 'Could not run the docker CLI. Is Docker installed and on PATH for the Switchyard user?',
        errors: [psResult.spawnError.message],
        output: toCommandOutput(psResult),
      };
    }

    if (!psResult.ok) {
      const reason = failureReason(psResult);
      return {
        state: 'unknown',
        summary: reason,
        detail: dockerAccessHint(psResult.stderr) ?? 'docker compose ps failed.',
        errors: [reason],
        output: toCommandOutput(psResult),
      };
    }

    const containers = parsePs(psResult.stdout);
    const expected = await expectedServices(context, cwd);
    const inspected = await inspectContainers(context, containers, cwd);

    const children: ChildStatus[] = [];
    const ports: PortInfo[] = [];
    const urls: UrlInfo[] = [];
    const warnings: string[] = [];

    let running = 0;
    let restarting = 0;
    let unhealthy = 0;
    let healthy = 0;
    let failedExit = 0;
    let earliestStart: number | undefined;
    /** A container up without its port publish is not a healthy stack. */
    let unpublished = false;

    for (const container of containers) {
      const state = mapContainerState(container);
      const health = normaliseHealth(container.Health);
      const name = container.Name ?? container.Service ?? container.ID ?? 'container';
      const containerPorts = publishersToPorts(container.Publishers);

      if (state === 'running') running += 1;
      if (container.State === 'restarting') restarting += 1;
      if (health === 'unhealthy') unhealthy += 1;
      if (health === 'healthy') healthy += 1;
      if (state === 'failed') failedExit += 1;

      const details = container.ID ? inspected.get(container.ID) : undefined;
      const started = details?.startedAt;
      if (started && state === 'running') {
        const ts = Date.parse(started);
        if (!Number.isNaN(ts) && (earliestStart === undefined || ts < earliestStart)) earliestStart = ts;
      }

      const metrics: Metric[] = [];
      if (container.Image) metrics.push({ label: 'Image', value: container.Image, kind: 'mono' });
      if (started) metrics.push({ label: 'Started', value: started, kind: 'timestamp' });
      if (typeof container.ExitCode === 'number' && state !== 'running' && container.ExitCode !== 0) {
        metrics.push({ label: 'Exit code', value: String(container.ExitCode), kind: 'number', tone: 'bad' });
      }

      children.push({
        id: container.ID ?? name,
        name,
        state,
        stateLabel: container.Status ?? container.State,
        health,
        image: container.Image,
        ports: containerPorts,
        metrics,
        service: container.Service,
      });

      for (const port of containerPorts) {
        if (!ports.some((existing) => existing.hostPort === port.hostPort && existing.protocol === port.protocol)) {
          ports.push(port);
        }
      }

      if (health === 'unhealthy') warnings.push(`${name} reports unhealthy`);
      if (state === 'failed') warnings.push(`${name} exited with code ${container.ExitCode}`);
      // "created" means the container exists but was never started — typically a
      // start that failed (port collision, missing mount, bad image entrypoint).
      if (container.State === 'created') {
        warnings.push(`${name} was created but never started — check the last action output`);
      }
      if (details && details.unpublished.length > 0) {
        unpublished = true;
        warnings.push(
          `${name} is running without its published port(s) ${details.unpublished.join(', ')} — ` +
            'the host port is most likely taken by another process',
        );
      }
    }

    // Published ports are reported as ports, not as URLs: a published 5432 is
    // not an HTTP endpoint, and guessing would produce dead links. Services that
    // do have a URL declare it in the config.

    const total = Math.max(expected.length, containers.length);
    const missing = expected.filter(
      (name) => !containers.some((container) => container.Service === name),
    );
    if (missing.length > 0 && running > 0) {
      warnings.push(`no container for service(s): ${missing.join(', ')}`);
    }

    const state = aggregateState({
      total,
      running,
      restarting,
      unhealthy,
      failedExit,
      containerCount: containers.length,
      requireHealthchecks: config.requireHealthchecks,
      healthy,
      unpublished,
    });

    const metrics: Metric[] = [
      {
        label: 'Containers',
        value: `${running}/${total || containers.length}`,
        // Not highlighted: the card header already carries the running/total
        // count next to the provider label.
        tone: running === 0 ? 'default' : running === total ? 'good' : 'warn',
      },
    ];
    if (unhealthy > 0) metrics.push({ label: 'Unhealthy', value: String(unhealthy), kind: 'number', tone: 'bad' });
    if (healthy > 0) metrics.push({ label: 'Healthy', value: String(healthy), kind: 'number', tone: 'good' });
    if (config.projectName) metrics.push({ label: 'Project', value: config.projectName, kind: 'mono' });
    const composeFile = config.file ?? config.files[0];
    if (composeFile) metrics.push({ label: 'Compose file', value: composeFile, kind: 'mono' });

    return {
      state,
      summary: summarise(state, running, total || containers.length, unhealthy, unpublished),
      detail: children.length === 0 ? 'No containers exist for this project yet.' : undefined,
      since: earliestStart ? new Date(earliestStart).toISOString() : null,
      metrics,
      warnings,
      children,
      ports,
      urls,
      output: toCommandOutput(psResult),
    };
  },

  async runAction(context, descriptor): Promise<ActionOutcome> {
    const id = descriptor.id as ComposeAction;
    const meta = ACTION_META[id];
    if (!meta || !context.config.actions.includes(id)) {
      return { ok: false, message: `action ${descriptor.id} is not enabled for this stack` };
    }

    const result = await context.execRaw({
      argv: [...composeBaseArgv(context.config), ...meta.args],
      cwd: projectCwd(context),
      env: context.service.env,
      timeoutMs: meta.slow ? context.config.slowTimeoutMs : context.service.timeout,
      label: `${context.service.id}:${id}`,
    });

    if (!result.ok) {
      const hint = dockerAccessHint(result.stderr);
      return {
        ok: false,
        // Compose streams per-container progress to stderr, so the first line is
        // noise like "Container x Running" and the real cause is at the end.
        message: `${meta.label} failed: ${hint ?? composeErrorLine(result.stderr) ?? failureReason(result)}`,
        output: toCommandOutput(result),
      };
    }

    // Compose writes progress to stderr; surface its last line as the message.
    const detail = firstMeaningfulLine(result.stdout) ?? lastLine(result.stderr);
    return {
      ok: true,
      message: detail ? `${meta.label} completed — ${detail}` : `${meta.label} completed`,
      output: toCommandOutput(result),
    };
  },

  async logs(context, options): Promise<LogsResult> {
    const result = await context.execRaw({
      argv: [
        ...composeBaseArgv(context.config),
        'logs',
        '--no-color',
        '--tail',
        String(options.tail),
        // Positional args after the options restrict output to those services;
        // omitting them (the common case) logs the whole stack.
        ...(options.containers ?? []),
      ],
      cwd: projectCwd(context),
      env: context.service.env,
      timeoutMs: context.service.timeout,
      label: `${context.service.id}:logs`,
    });

    if (result.spawnError) {
      return { source: 'docker compose logs', lines: [`error: ${result.spawnError.message}`] };
    }
    if (!result.ok && !result.stdout.trim()) {
      return {
        source: 'docker compose logs',
        lines: [`error: ${dockerAccessHint(result.stderr) ?? failureReason(result)}`],
      };
    }

    return {
      source: 'docker compose logs',
      lines: splitLines(result.stdout, options.tail),
      truncated: result.truncated,
    };
  },
};

/**
 * `docker compose ps --format json` emits either a JSON array or one JSON
 * object per line depending on the compose version. Handle both.
 */
function parsePs(stdout: string): ComposePs[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as ComposePs[];
    if (parsed && typeof parsed === 'object') return [parsed as ComposePs];
  } catch {
    // fall through to JSON Lines
  }
  const containers: ComposePs[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      containers.push(JSON.parse(trimmed) as ComposePs);
    } catch {
      // ignore non-JSON noise
    }
  }
  return containers;
}

async function expectedServices(context: ProviderContext<ComposeConfig>, cwd?: string): Promise<string[]> {
  const cacheKey = context.service.id;
  const cached = serviceListCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < SERVICE_LIST_TTL_MS) return cached.services;

  const result = await context.execRaw({
    argv: [...composeBaseArgv(context.config), 'config', '--services'],
    cwd,
    env: context.service.env,
    timeoutMs: context.service.timeout,
    label: `${context.service.id}:services`,
  });

  if (!result.ok) {
    // Keep a stale list rather than reporting a bogus 0/0.
    return cached?.services ?? [];
  }

  const services = splitLines(result.stdout).map((line) => line.trim()).filter(Boolean);
  serviceListCache.set(cacheKey, { at: now, services });
  return services;
}

interface Inspected {
  startedAt?: string;
  /** Host ports the container config asks for, e.g. ["8080/tcp → 8080"]. */
  unpublished: string[];
}

/**
 * One batched `docker inspect` per poll, for the two things `compose ps` cannot
 * answer:
 *
 *  - the exact start time (ps only exposes creation time), and
 *  - whether the requested port publishes are actually in effect.
 *
 * The second check matters: when a host port is already taken, Docker may start
 * the container anyway with no port mapping at all. The container then reports
 * running *and* healthy — its healthcheck runs inside the container — while
 * being unreachable from the host. Without this comparison the dashboard would
 * show a perfectly green stack that nothing can connect to.
 *
 * Container ids come from docker itself and are passed as argv entries.
 */
async function inspectContainers(
  context: ProviderContext<ComposeConfig>,
  containers: ComposePs[],
  cwd?: string,
): Promise<Map<string, Inspected>> {
  const ids = containers
    .filter((container) => container.State === 'running' || container.State === 'restarting')
    .map((container) => container.ID)
    .filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{6,64}$/i.test(id));

  const map = new Map<string, Inspected>();
  if (ids.length === 0) return map;

  const result = await context.execRaw({
    argv: [
      context.config.dockerPath,
      'inspect',
      '--format',
      '{{.Id}}\t{{.State.StartedAt}}\t{{json .HostConfig.PortBindings}}\t{{json .NetworkSettings.Ports}}',
      ...ids,
    ],
    cwd,
    env: context.service.env,
    timeoutMs: context.service.timeout,
    label: `${context.service.id}:inspect`,
  });

  if (!result.ok) return map;

  for (const line of splitLines(result.stdout)) {
    const [id, startedAt, requestedJson, actualJson] = line.split('\t');
    if (!id) continue;
    const entry: Inspected = {
      startedAt: startedAt?.trim() || undefined,
      unpublished: missingPublishes(requestedJson, actualJson),
    };
    // `docker inspect` returns the full 64-character id while `compose ps`
    // reports the 12-character short form; index both so either matches.
    map.set(id, entry);
    if (id.length > 12) map.set(id.slice(0, 12), entry);
  }
  return map;
}

type BindingMap = Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;

/** Requested host publishes that are absent from the live container. */
function missingPublishes(requestedJson?: string, actualJson?: string): string[] {
  let requested: BindingMap = null;
  let actual: BindingMap = null;
  try {
    requested = requestedJson ? (JSON.parse(requestedJson) as BindingMap) : null;
    actual = actualJson ? (JSON.parse(actualJson) as BindingMap) : null;
  } catch {
    return [];
  }
  if (!requested) return [];

  const missing: string[] = [];
  for (const [spec, bindings] of Object.entries(requested)) {
    if (!bindings || bindings.length === 0) continue;
    const live = actual?.[spec];
    if (live && live.length > 0) continue;
    for (const binding of bindings) {
      if (binding.HostPort) missing.push(`${binding.HostPort} → ${spec}`);
    }
  }
  return missing;
}

function mapContainerState(container: ComposePs): ServiceState {
  switch (container.State) {
    case 'running':
      return normaliseHealth(container.Health) === 'unhealthy' ? 'degraded' : 'running';
    case 'restarting':
      return 'starting';
    case 'created':
    case 'paused':
      return 'stopped';
    case 'removing':
      return 'stopping';
    case 'dead':
      return 'failed';
    case 'exited':
      return typeof container.ExitCode === 'number' && container.ExitCode !== 0 ? 'failed' : 'stopped';
    default:
      return 'unknown';
  }
}

function normaliseHealth(health?: string): ChildStatus['health'] {
  switch (health) {
    case 'healthy':
      return 'healthy';
    case 'unhealthy':
      return 'unhealthy';
    case 'starting':
      return 'starting';
    default:
      return 'none';
  }
}

function publishersToPorts(publishers: ComposePs['Publishers']): PortInfo[] {
  if (!publishers) return [];
  const ports: PortInfo[] = [];
  for (const publisher of publishers) {
    if (!publisher.PublishedPort) continue;
    ports.push({
      port: publisher.TargetPort ?? publisher.PublishedPort,
      hostPort: publisher.PublishedPort,
      protocol: publisher.Protocol === 'udp' ? 'udp' : 'tcp',
    });
  }
  return ports;
}

function aggregateState(input: {
  total: number;
  running: number;
  restarting: number;
  unhealthy: number;
  failedExit: number;
  containerCount: number;
  healthy: number;
  requireHealthchecks: boolean;
  unpublished: boolean;
}): ServiceState {
  const { total, running, restarting, unhealthy, failedExit, containerCount, healthy, requireHealthchecks } = input;

  if (containerCount === 0) return total === 0 ? 'unknown' : 'stopped';
  if (restarting > 0) return 'starting';
  if (running === 0) return failedExit > 0 ? 'failed' : 'stopped';
  if (unhealthy > 0) return 'degraded';
  // Up, but something cannot reach it from the host.
  if (input.unpublished) return 'degraded';
  if (total > 0 && running < total) return 'degraded';
  if (requireHealthchecks && healthy < running) return 'degraded';
  return 'running';
}

function summarise(
  state: ServiceState,
  running: number,
  total: number,
  unhealthy: number,
  unpublished: boolean,
): string {
  if (state === 'running') return `${running}/${total} containers up`;
  if (state === 'degraded' && unhealthy > 0) return `${running}/${total} up · ${unhealthy} unhealthy`;
  if (state === 'degraded' && unpublished) return `${running}/${total} up · port publish failed`;
  if (state === 'degraded') return `${running}/${total} containers up`;
  if (state === 'starting') return 'containers restarting';
  if (state === 'failed') return 'stack exited with errors';
  if (state === 'stopped') return total > 0 ? `0/${total} containers up` : 'stack is down';
  return 'stack state unknown';
}

/**
 * Picks the meaningful failure line out of compose's stderr: the last line that
 * looks like an error, falling back to the last line of output.
 */
function composeErrorLine(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const errorish = lines.filter((line) =>
    /(^error|error response|failed|cannot|denied|refused|no such|already in use|not found|unauthorized)/i.test(line),
  );

  const chosen = errorish.at(-1) ?? lines.at(-1);
  if (!chosen) return undefined;
  return chosen.length > 300 ? `${chosen.slice(0, 300)}…` : chosen;
}

function lastLine(text: string): string | undefined {
  const lines = text.trimEnd().split('\n').filter((line) => line.trim());
  const last = lines.at(-1)?.trim();
  if (!last) return undefined;
  return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/** Docker's permission errors are common and confusing; explain them once. */
function dockerAccessHint(stderr: string): string | undefined {
  if (/permission denied while trying to connect to the Docker daemon/i.test(stderr)) {
    return 'permission denied on the Docker socket — add the Switchyard user to the "docker" group or use rootless Docker (see docs/PRIVILEGES.md)';
  }
  if (/Cannot connect to the Docker daemon/i.test(stderr)) {
    return 'the Docker daemon is not reachable — is it running, and is DOCKER_HOST correct?';
  }
  if (/no configuration file provided/i.test(stderr)) {
    return 'no compose file found — set provider.file or provider.projectDir';
  }
  const port = portConflict(stderr);
  if (port) {
    return `port ${port} is already in use by another process on the host — stop whatever's bound to it, or change the published port in the compose file`;
  }
  return undefined;
}

/**
 * Docker's networking-setup failure buries the actual port behind two layers
 * of wrapper text ("failed to set up container networking: driver failed
 * programming external connectivity ... Bind for 0.0.0.0:PORT failed: port is
 * already allocated"). Pull just the port out so the hint above can name it.
 */
function portConflict(stderr: string): string | undefined {
  const match = stderr.match(/Bind for [\d.]+:(\d+) failed: port is already allocated/i);
  return match?.[1];
}
