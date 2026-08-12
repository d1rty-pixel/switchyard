/**
 * Shared domain types.
 *
 * These types describe the contract between providers, the service manager and
 * the HTTP API. The frontend mirrors the wire-facing subset in
 * `packages/web/src/lib/types.ts`.
 */

/** Lifecycle state of a managed service. */
export type ServiceState =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'degraded'
  | 'failed'
  | 'unknown';

/** Every state a provider may report, in "healthiness" order (best first). */
export const SERVICE_STATES: ServiceState[] = [
  'running',
  'starting',
  'stopping',
  'degraded',
  'failed',
  'stopped',
  'unknown',
];

export type MetricTone = 'default' | 'good' | 'warn' | 'bad';
export type MetricKind = 'text' | 'mono' | 'number' | 'bytes' | 'duration' | 'timestamp';

/** A single labelled piece of provider metadata rendered in the UI. */
export interface Metric {
  label: string;
  value: string;
  kind?: MetricKind;
  tone?: MetricTone;
  /** Show on the compact card as well, not only in the detail drawer. */
  highlight?: boolean;
}

export interface PortInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  label?: string;
  /** Host-side published port, when it differs (containers). */
  hostPort?: number;
  url?: string;
}

export interface UrlInfo {
  label: string;
  url: string;
  primary?: boolean;
}

/** A sub-unit of a service: a compose container, a worker process, ... */
export interface ChildStatus {
  id: string;
  name: string;
  state: ServiceState;
  /** Provider-native state string, e.g. `exited (137)`. */
  stateLabel?: string;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  image?: string;
  ports?: PortInfo[];
  metrics?: Metric[];
  /** Compose service key (not the container name), when the provider has one. Used to filter logs. */
  service?: string;
}

/** Raw backend output attached to a status probe or an action. */
export interface CommandOutput {
  argv?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface StatusResult {
  state: ServiceState;
  /** One short line, shown on the card under the status badge. */
  summary?: string;
  /** Longer explanation for the drawer. */
  detail?: string;
  /** ISO timestamp the service entered its current state, for uptime display. */
  since?: string | null;
  metrics?: Metric[];
  warnings?: string[];
  errors?: string[];
  children?: ChildStatus[];
  /** Runtime-discovered ports; merged with statically configured ones. */
  ports?: PortInfo[];
  /** Runtime-discovered URLs. */
  urls?: UrlInfo[];
  /** Last backend command executed for this probe (drawer diagnostics). */
  output?: CommandOutput;
  /** Provider-native key/value data, shown verbatim in the detail drawer. */
  raw?: Record<string, string>;
}

export type ActionKind = 'primary' | 'secondary' | 'danger' | 'utility';

/**
 * Describes one executable operation. Action descriptors are the *only* thing
 * the API will dispatch: an incoming action id must match a descriptor id.
 */
export interface ActionDescriptor {
  id: string;
  label: string;
  kind: ActionKind;
  icon?: string;
  description?: string;
  /** Require an explicit confirmation step in the UI. */
  confirm?: boolean;
  /** UI hint: only offer the action in these states (empty = always). */
  enabledIn?: ServiceState[];
  /** UI hint: this action is expected to take a while. */
  slow?: boolean;
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
  output?: CommandOutput;
}

export interface ActionRecord {
  actionId: string;
  label: string;
  ok: boolean;
  message: string;
  startedAt: string;
  durationMs: number;
  exitCode?: number | null;
  /** First lines of stderr, for the history list. */
  excerpt?: string;
}

export interface LogsResult {
  source: string;
  lines: string[];
  truncated?: boolean;
}
