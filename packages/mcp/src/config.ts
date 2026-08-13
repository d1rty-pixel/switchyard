/**
 * Where the MCP process finds Switchyard, and how long it waits.
 *
 * There is exactly one input here — a base URL — because everything else this
 * server knows comes from the running Switchyard over HTTP. No config file, no
 * service catalogue, no thresholds: duplicating any of that would create a second
 * source of truth that can disagree with the dashboard.
 */

export interface McpConfig {
  baseUrl: string;
  /** Timeout for ordinary reads. */
  timeoutMs: number;
  /** Timeout for log fetches, which shell out to journalctl/docker logs. */
  logsTimeoutMs: number;
  /** Timeout for actions, which may pull images or restart a stack. */
  actionTimeoutMs: number;
}

export const DEFAULT_BASE_URL = 'http://127.0.0.1:7878';
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_LOGS_TIMEOUT_MS = 60_000;
export const DEFAULT_ACTION_TIMEOUT_MS = 300_000;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface ResolveInput {
  argv?: string[];
  env?: Record<string, string | undefined>;
}

/**
 * `--url` wins over `SWITCHYARD_URL`, which wins over the loopback default.
 *
 * A non-loopback URL is accepted — someone may run Switchyard on another host
 * behind their own proxy — but this process never opens a listener of its own, so
 * the trust boundary is unchanged either way.
 */
export function resolveConfig({ argv = [], env = process.env }: ResolveInput = {}): McpConfig {
  let url: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url' || arg === '-u') {
      const value = argv[index + 1];
      if (!value) throw new ConfigError('missing value for --url');
      url = value;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--url=')) {
      url = arg.slice('--url='.length);
      continue;
    }
    throw new ConfigError(`unknown argument: ${arg}`);
  }

  return {
    baseUrl: normaliseUrl(url ?? env.SWITCHYARD_URL ?? DEFAULT_BASE_URL),
    timeoutMs: positiveInt(env.SWITCHYARD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'SWITCHYARD_TIMEOUT_MS'),
    logsTimeoutMs: positiveInt(
      env.SWITCHYARD_LOGS_TIMEOUT_MS,
      DEFAULT_LOGS_TIMEOUT_MS,
      'SWITCHYARD_LOGS_TIMEOUT_MS',
    ),
    actionTimeoutMs: positiveInt(
      env.SWITCHYARD_ACTION_TIMEOUT_MS,
      DEFAULT_ACTION_TIMEOUT_MS,
      'SWITCHYARD_ACTION_TIMEOUT_MS',
    ),
  };
}

/** Rejects anything that is not an http(s) origin, and drops a trailing slash. */
export function normaliseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new ConfigError(`not a valid URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`unsupported protocol "${parsed.protocol}" in ${input} — use http or https`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer of milliseconds, got "${raw}"`);
  }
  return value;
}

export const HELP = `switchyard-mcp — MCP server for a running Switchyard

Speaks MCP over stdio and talks to Switchyard's HTTP API. Start Switchyard
separately; this process only reads and drives it, and holds no state of its own.

Usage: switchyard-mcp [--url <http://host:port>]

Options:
  -u, --url <url>   Switchyard base URL (default ${DEFAULT_BASE_URL})
  -h, --help        Print this help
  -v, --version     Print version

Environment:
  SWITCHYARD_URL                 Base URL, same as --url
  SWITCHYARD_TIMEOUT_MS          Read timeout (default ${DEFAULT_TIMEOUT_MS})
  SWITCHYARD_LOGS_TIMEOUT_MS     Log fetch timeout (default ${DEFAULT_LOGS_TIMEOUT_MS})
  SWITCHYARD_ACTION_TIMEOUT_MS   Action timeout (default ${DEFAULT_ACTION_TIMEOUT_MS})
`;
