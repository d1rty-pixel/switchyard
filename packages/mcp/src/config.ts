/**
 * Where the MCP process finds Switchyard, and how long it waits.
 *
 * There is exactly one input here — a base URL — because everything else this
 * server knows comes from the running Switchyard over HTTP. No config file, no
 * service catalogue, no thresholds: duplicating any of that would create a second
 * source of truth that can disagree with the dashboard.
 */

/**
 * How the client reaches this server.
 *
 * `stdio` is the default and the one the committed `.mcp.json` uses: the client
 * spawns the process, and it lives exactly as long as that connection. `http`
 * makes it a long-running daemon instead — which is what allows a *global*, once
 * registered, reusable-from-any-project client entry (a URL needs no path into
 * this checkout), and what gives Switchyard something it can actually manage.
 */
export type TransportKind = 'stdio' | 'http';

export interface HttpOptions {
  host: string;
  port: number;
  /** Endpoint path the MCP protocol is served on. */
  path: string;
}

export interface McpConfig {
  transport: TransportKind;
  http: HttpOptions;
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
/** One past Switchyard's own port, so the pair is easy to remember. */
export const DEFAULT_HTTP_PORT = 7879;
export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PATH = '/mcp';

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
  let transport: TransportKind | undefined;
  let host: string | undefined;
  let port: string | undefined;
  let path: string | undefined;

  /** `--flag value` and `--flag=value` both, since both get typed. */
  const valued = (
    arg: string,
    index: number,
    names: string[],
  ): { value: string; skip: boolean } | undefined => {
    for (const name of names) {
      if (arg === name) {
        const value = argv[index + 1];
        if (!value) throw new ConfigError(`missing value for ${name}`);
        return { value, skip: true };
      }
      if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), skip: false };
    }
    return undefined;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';

    if (arg === '--http') {
      transport = 'http';
      continue;
    }
    if (arg === '--stdio') {
      transport = 'stdio';
      continue;
    }

    const asUrl = valued(arg, index, ['--url', '-u']);
    if (asUrl) {
      url = asUrl.value;
      if (asUrl.skip) index += 1;
      continue;
    }
    const asPort = valued(arg, index, ['--port', '-p']);
    if (asPort) {
      port = asPort.value;
      if (asPort.skip) index += 1;
      continue;
    }
    const asHost = valued(arg, index, ['--host']);
    if (asHost) {
      host = asHost.value;
      if (asHost.skip) index += 1;
      continue;
    }
    const asPath = valued(arg, index, ['--path']);
    if (asPath) {
      path = asPath.value;
      if (asPath.skip) index += 1;
      continue;
    }

    throw new ConfigError(`unknown argument: ${arg}`);
  }

  return {
    transport: transport ?? resolveTransport(env.SWITCHYARD_MCP_TRANSPORT),
    http: {
      host: loopbackOnly(host ?? env.SWITCHYARD_MCP_HOST ?? DEFAULT_HTTP_HOST),
      port: portNumber(port ?? env.SWITCHYARD_MCP_PORT, DEFAULT_HTTP_PORT),
      path: normalisePath(path ?? env.SWITCHYARD_MCP_PATH ?? DEFAULT_HTTP_PATH),
    },
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

function resolveTransport(raw: string | undefined): TransportKind {
  if (raw === undefined || raw === '') return 'stdio';
  if (raw === 'stdio' || raw === 'http') return raw;
  throw new ConfigError(`SWITCHYARD_MCP_TRANSPORT must be "stdio" or "http", got "${raw}"`);
}

/**
 * INVARIANT: the HTTP listener binds loopback only, and nothing can change that.
 *
 * Switchyard's own server has `settings.allowRemoteBind` for people who put the
 * dashboard behind an authenticating proxy. This deliberately has **no equivalent**
 * — not a flag, not an environment variable, not a config key. An MCP endpoint runs
 * actions, so a reachable one is a remote control panel for every service on the
 * machine with no credential anywhere in the path, and the service definition ships
 * enabled precisely because this cannot be relaxed.
 *
 * Every path into `McpConfig.http.host` goes through here. If a future change adds
 * another, it has to come through this function too.
 */
function loopbackOnly(host: string): string {
  if (host === 'localhost' || host === '::1' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)) {
    return host;
  }
  throw new ConfigError(
    `refusing to bind the MCP endpoint to ${host}: it can run actions and has no authentication, ` +
      'and there is no option to override this. Use a loopback address (127.0.0.1).',
  );
}

function portNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ConfigError(`port must be an integer between 1 and 65535, got "${raw}"`);
  }
  return value;
}

function normalisePath(raw: string): string {
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/health') {
    throw new ConfigError(`invalid MCP path "${raw}": pick something other than / or /health`);
  }
  return trimmed;
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

Talks to Switchyard's HTTP API. Start Switchyard separately; this process only
reads and drives it, and holds no state of its own.

Usage: switchyard-mcp [--url <http://host:port>] [--http [--port N]]

Transports:
  (default)         stdio — the client spawns this process and owns its lifetime
  --http            long-running HTTP daemon, so one global client entry can be
                    reused from any project and Switchyard can manage it

Options:
  -u, --url <url>   Switchyard base URL (default ${DEFAULT_BASE_URL})
  -p, --port <n>    HTTP mode: listen port (default ${DEFAULT_HTTP_PORT})
      --host <addr> HTTP mode: bind address, loopback only (default ${DEFAULT_HTTP_HOST})
      --path <p>    HTTP mode: endpoint path (default ${DEFAULT_HTTP_PATH})
  -h, --help        Print this help
  -v, --version     Print version

Environment:
  SWITCHYARD_URL                 Base URL, same as --url
  SWITCHYARD_MCP_TRANSPORT       stdio | http
  SWITCHYARD_MCP_HOST            HTTP bind address (loopback only)
  SWITCHYARD_MCP_PORT            HTTP listen port
  SWITCHYARD_MCP_PATH            HTTP endpoint path
  SWITCHYARD_TIMEOUT_MS          Read timeout (default ${DEFAULT_TIMEOUT_MS})
  SWITCHYARD_LOGS_TIMEOUT_MS     Log fetch timeout (default ${DEFAULT_LOGS_TIMEOUT_MS})
  SWITCHYARD_ACTION_TIMEOUT_MS   Action timeout (default ${DEFAULT_ACTION_TIMEOUT_MS})

Registering it globally, reusable from every project:
  # HTTP daemon (no path into this checkout, so it survives being moved)
  switchyard-mcp --http &
  claude mcp add --scope user --transport http switchyard http://127.0.0.1:${DEFAULT_HTTP_PORT}${DEFAULT_HTTP_PATH}

  # or stdio, via the linked bin
  npm link -w @switchyard/mcp
  claude mcp add --scope user switchyard -- switchyard-mcp
`;
