/**
 * Wire types. Mirrors the server's `core/views.ts` and `types.ts`.
 * Kept as a hand-maintained copy so the frontend has no build-time dependency
 * on the server package.
 */

export type ServiceState =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'degraded'
  | 'failed'
  | 'unknown';

export type MetricTone = 'default' | 'good' | 'warn' | 'bad';
export type MetricKind = 'text' | 'mono' | 'number' | 'bytes' | 'duration' | 'timestamp';

export interface Metric {
  label: string;
  value: string;
  kind?: MetricKind;
  tone?: MetricTone;
  highlight?: boolean;
}

export interface PortInfo {
  port: number;
  protocol: 'tcp' | 'udp';
  label?: string;
  hostPort?: number;
  url?: string;
}

export interface UrlInfo {
  label: string;
  url: string;
  primary?: boolean;
}

export type ActionKind = 'primary' | 'secondary' | 'danger' | 'utility';

export interface ActionDescriptor {
  id: string;
  label: string;
  kind: ActionKind;
  icon?: string;
  description?: string;
  confirm?: boolean;
  enabledIn?: ServiceState[];
  slow?: boolean;
}

export interface CommandOutput {
  argv?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export interface ActionRecord {
  actionId: string;
  label: string;
  ok: boolean;
  message: string;
  startedAt: string;
  durationMs: number;
  exitCode?: number | null;
  excerpt?: string;
}

export interface ChildStatus {
  id: string;
  name: string;
  state: ServiceState;
  stateLabel?: string;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  image?: string;
  ports?: PortInfo[];
  metrics?: Metric[];
}

export interface ServiceSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  type: string;
  providerLabel: string;
  group: string;
  tags: string[];
  order?: number;

  state: ServiceState;
  statusSummary?: string;
  since?: string | null;
  lastCheckedAt?: string | null;
  checking: boolean;
  busy?: { actionId: string; label: string; startedAt: string } | null;

  metrics: Metric[];
  warnings: string[];
  errors: string[];
  ports: PortInfo[];
  urls: UrlInfo[];
  actions: ActionDescriptor[];
  supportsLogs: boolean;
  children?: { total: number; running: number };
  lastAction?: ActionRecord | null;
}

export interface ServiceDetail extends ServiceSummary {
  statusDetail?: string;
  childStatuses: ChildStatus[];
  history: ActionRecord[];
  raw?: Record<string, string>;
  lastProbe?: CommandOutput;
  workdir?: string;
  source: string;
  envKeys: string[];
  providerConfig: unknown;
}

export interface DisabledService {
  id: string;
  name: string;
  type: string;
  group: string;
  source: string;
}

export interface GroupDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  order?: number;
}

export interface MetaResponse {
  app: { name: string; version: string };
  configPath: string;
  serviceDirs: string[];
  configWarnings: string[];
  disabledServices: DisabledService[];
  groups: GroupDefinition[];
  providers: { type: string; label: string; description: string }[];
  settings: { statusIntervalMs: number; logsTail: number };
}

export interface ActionResponse {
  ok: boolean;
  message: string;
  record: ActionRecord;
  output?: CommandOutput;
  service: ServiceSummary;
}

export interface LogsResponse {
  id: string;
  source: string;
  lines: string[];
  truncated?: boolean;
  fetchedAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
