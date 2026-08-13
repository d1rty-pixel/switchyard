/**
 * Wire types. Mirrors the server's `core/views.ts`, `core/resource-view.ts`,
 * `core/resource-history.ts` and `types.ts`.
 *
 * Kept as a hand-maintained copy for the same reason `packages/web/src/lib/types.ts`
 * is: the MCP process has no build-time dependency on the server package, so it
 * can be built, shipped and run on its own. Nothing here is validated at runtime —
 * the server is the authority on its own payloads.
 */

export type ServiceState =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'degraded'
  | 'failed'
  | 'unknown';

export type MetricKind = 'text' | 'mono' | 'number' | 'bytes' | 'duration' | 'timestamp';
export type MetricTone = 'default' | 'good' | 'warn' | 'bad';

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

export interface ChildStatus {
  id: string;
  name: string;
  state: ServiceState;
  stateLabel?: string;
  health?: 'healthy' | 'unhealthy' | 'starting' | 'none';
  image?: string;
  ports?: PortInfo[];
  metrics?: Metric[];
  service?: string;
}

export interface CommandOutput {
  argv?: string[];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
}

export type ActionKind = 'primary' | 'secondary' | 'danger' | 'utility';

export interface ActionDescriptor {
  id: string;
  label: string;
  kind: ActionKind;
  icon?: string;
  description?: string;
  /** The dashboard asks before running this; so does `run_action`. */
  confirm?: boolean;
  enabledIn?: ServiceState[];
  slow?: boolean;
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

// ── resources ─────────────────────────────────────────────────────────────────

export type ResourceMetric = 'cpu' | 'memory' | 'diskRead' | 'diskWrite' | 'netRx' | 'netTx';
export type ResourceUnit = 'percent' | 'bytes' | 'bytesPerSecond';

export const RESOURCE_METRICS: ResourceMetric[] = [
  'cpu',
  'memory',
  'diskRead',
  'diskWrite',
  'netRx',
  'netTx',
];

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
  attribution: string;
  memoryLimitBytes?: number;
  children?: ResourceChildSample[];
}

export type AlertSeverity = 'warning' | 'critical';

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

export interface ResolvedThreshold {
  warning?: number;
  critical?: number;
  forMs: number;
  unit: ResourceUnit;
}

export interface ResolvedMonitoring {
  enabled: boolean;
  clearBelow: number;
  cooldownMs: number;
  thresholds: Partial<Record<ResourceMetric, ResolvedThreshold>>;
}

export type ThresholdState = 'critical' | 'warning' | 'pending' | 'ok' | 'no-threshold' | 'unmeasured';
export type SamplingState = 'ok' | 'off' | 'paused' | 'no-sample';

export interface ResourceMetricView {
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
  value?: number;
  state: ThresholdState;
  warning?: number;
  critical?: number;
  forMs?: number;
  percentOfWarning?: number;
  percentOfCritical?: number;
  pendingSeverity?: AlertSeverity;
  breachingForMs?: number;
  activatesInMs?: number;
  alertKey?: string;
}

export interface ChildResourceView extends ResourceChildSample {
  percentOfMemoryLimit?: number;
}

export interface ServiceResourceView {
  id: string;
  name: string;
  type: string;
  providerLabel: string;
  group: string;
  state: ServiceState;
  monitored: boolean;
  sampling: SamplingState;
  sampledAt?: string;
  ageMs?: number;
  attribution?: string;
  metrics: ResourceMetricView[];
  /** Metrics with no measurement for this service — absent, not zero. */
  unmeasured: ResourceMetric[];
  memory?: { bytes: number; limitBytes?: number; percentOfLimit?: number };
  alerts: ResourceAlert[];
  children?: ChildResourceView[];
  worst: ThresholdState;
  historySamples: number;
}

export interface HostInfo {
  hostname: string;
  cpuCount: number;
  totalMemoryBytes: number;
}

export interface MetricCatalogEntry {
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
}

export interface ResourcesResponse {
  at: string;
  host: HostInfo;
  monitoring: {
    enabled: boolean;
    intervalMs: number;
    historyMs: number;
    metrics: MetricCatalogEntry[];
  };
  truncated: number;
  services: ServiceResourceView[];
}

export interface MetricStats {
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
  samples: number;
  min: number;
  max: number;
  average: number;
  p95: number;
  latest: number;
  firstAt: string;
  lastAt: string;
  spanMs: number;
  fractionAboveWarning?: number;
  fractionAboveCritical?: number;
  warning?: number;
  critical?: number;
}

export interface HistoryBucket {
  at: string;
  endAt: string;
  samples: number;
  values: Partial<Record<ResourceMetric, { average: number; max: number }>>;
}

export interface HistoryResponse {
  id: string;
  windowMs: number;
  from: string;
  to: string;
  retentionMs: number;
  samples: number;
  spanMs: number;
  intervalMs: number;
  stats: MetricStats[];
  buckets: HistoryBucket[];
}

// ── services ──────────────────────────────────────────────────────────────────

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
  history: ActionRecord[];
  raw?: Record<string, string>;
  lastProbe?: CommandOutput;
  workdir?: string;
  source: string;
  /** Names only; the server never sends environment values. */
  envKeys: string[];
  /** Redacted server-side. Not exposed by any MCP tool. */
  providerConfig: unknown;
  monitoringConfig: ResolvedMonitoring;
}

export interface ServicesResponse {
  services: ServiceSummary[];
}

export interface AlertsResponse {
  alerts: ResourceAlert[];
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  uptimeMs: number;
  services: number;
  subscribers: number;
}

export interface GroupDefinition {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  order?: number;
}

export interface DisabledService {
  id: string;
  name: string;
  type: string;
  group: string;
  source: string;
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
  host: HostInfo;
  monitoring: {
    enabled: boolean;
    intervalMs: number;
    historyMs: number;
    metrics: MetricCatalogEntry[];
    defaults: { forMs: number; clearBelow: number; cooldownMs: number; historyMs: number };
    thresholds: Partial<Record<ResourceMetric, ResolvedThreshold>>;
  };
}

export interface LogsResponse {
  id: string;
  source: string;
  lines: string[];
  truncated?: boolean;
  fetchedAt: string;
}

export interface ActionResponse {
  ok: boolean;
  message: string;
  record: ActionRecord;
  output?: CommandOutput;
  service: ServiceSummary;
}

export interface RefreshResponse {
  service: ServiceSummary;
}

export interface ConfigDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
}

export interface ReloadPreviewResponse {
  path: string;
  services: number;
  warnings: string[];
  diff: ConfigDiff;
}

export interface ReloadResponse {
  ok: boolean;
  path: string;
  services: number;
  warnings: string[];
}
