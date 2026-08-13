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

export type HistoryKind = 'action' | 'rejected' | 'alert' | 'state' | 'probe' | 'config';
export type HistorySeverity = 'info' | 'warning' | 'error';

/** One thing that happened to a service. Payload members follow `kind`. */
export interface HistoryEntry {
  kind: HistoryKind;
  at: string;
  severity: HistorySeverity;
  label: string;
  message: string;
  action?: ActionRecord;
  alert?: HistoryAlert;
  state?: { from: ServiceState; to: ServiceState };
}

export interface HistoryAlert {
  event: AlertEventKind;
  metric: ResourceMetric;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  unit: ResourceUnit;
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
  /** Compose service key (not the container name), when the provider has one. Used to filter logs. */
  service?: string;
}

export type ResourceMetric = 'cpu' | 'memory' | 'diskRead' | 'diskWrite' | 'netRx' | 'netTx';
export type ResourceUnit = 'percent' | 'bytes' | 'bytesPerSecond';
export type AlertSeverity = 'warning' | 'critical';
export type AlertEventKind = 'activated' | 'escalated' | 'deescalated' | 'cleared';

/** Measured per-service consumption. Absent fields are not measurable. */
export interface ResourceValues {
  cpuPercent?: number;
  memoryBytes?: number;
  diskReadBps?: number;
  diskWriteBps?: number;
  netRxBps?: number;
  netTxBps?: number;
}

export interface ResourceChildSample extends ResourceValues {
  id: string;
  name: string;
  memoryLimitBytes?: number;
}

export interface ResourceSample extends ResourceValues {
  at: string;
  /** What the numbers are attributed to, in the provider's words. */
  attribution: string;
  memoryLimitBytes?: number;
  children?: ResourceChildSample[];
}

export interface ResourceAlert {
  key: string;
  serviceId: string;
  serviceName: string;
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
  severity: AlertSeverity;
  value: number;
  threshold: number;
  breachedAt: string;
  activatedAt: string;
  updatedAt: string;
  active: boolean;
  clearedAt?: string;
  stale?: boolean;
}

export interface ResourceAlertEvent {
  event: AlertEventKind;
  alert: ResourceAlert;
  /** Whether the server considers this worth a desktop notification. */
  notify: boolean;
  reason: string;
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

  resources: ResourceSample | null;
  alerts: ResourceAlert[];
  monitored: boolean;
}

export interface ServiceDetail extends ServiceSummary {
  statusDetail?: string;
  childStatuses: ChildStatus[];
  history: HistoryEntry[];
  raw?: Record<string, string>;
  lastProbe?: CommandOutput;
  workdir?: string;
  source: string;
  envKeys: string[];
  providerConfig: unknown;
  monitoringConfig: ResolvedMonitoring;
}

/** Effective monitoring configuration for one service, global defaults merged. */
export interface ResolvedThreshold {
  warning?: number;
  critical?: number;
  /** Sustained duration before an alert activates, in milliseconds. */
  forMs: number;
  unit: ResourceUnit;
}

export interface ResolvedMonitoring {
  enabled: boolean;
  clearBelow: number;
  cooldownMs: number;
  thresholds: Partial<Record<ResourceMetric, ResolvedThreshold>>;
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
  settings: {
    statusIntervalMs: number;
    logsTail: number;
    monitoring: { enabled: boolean; intervalMs: number };
  };
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

export interface ConfigDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

export interface ReloadPreview {
  path: string;
  services: number;
  warnings: string[];
  diff: ConfigDiff;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * How the service list is laid out. Not a wire type — a UI preference, kept
 * here so the top bar and the dashboard agree on it.
 */
export type ViewMode = 'cards' | 'table';
