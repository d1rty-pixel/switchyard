/**
 * The common resource model.
 *
 * One vocabulary for every provider: six metrics, all optional. A provider
 * reports what its backend can actually attribute to the service and omits the
 * rest — an unsupported metric is *absent*, never zero, so nothing downstream
 * can mistake "not measured" for "idle".
 *
 * Everything here describes *per-service* consumption. Machine-wide load is a
 * different question and is deliberately not part of this model: a service card
 * showing host CPU would blame the wrong service for someone else's compile job.
 */

export const RESOURCE_METRICS = ['cpu', 'memory', 'diskRead', 'diskWrite', 'netRx', 'netTx'] as const;

export type ResourceMetric = (typeof RESOURCE_METRICS)[number];

export type ResourceUnit = 'percent' | 'bytes' | 'bytesPerSecond';

/** Static description of one metric: label, unit and the field carrying it. */
export interface ResourceMetricInfo {
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
  field: keyof ResourceValues;
}

export const RESOURCE_METRIC_INFO: Record<ResourceMetric, ResourceMetricInfo> = {
  // 100 % is one fully busy core, matching `top` and `docker stats`.
  cpu: { metric: 'cpu', label: 'CPU', unit: 'percent', field: 'cpuPercent' },
  memory: { metric: 'memory', label: 'Memory', unit: 'bytes', field: 'memoryBytes' },
  diskRead: { metric: 'diskRead', label: 'Disk read', unit: 'bytesPerSecond', field: 'diskReadBps' },
  diskWrite: { metric: 'diskWrite', label: 'Disk write', unit: 'bytesPerSecond', field: 'diskWriteBps' },
  netRx: { metric: 'netRx', label: 'Net in', unit: 'bytesPerSecond', field: 'netRxBps' },
  netTx: { metric: 'netTx', label: 'Net out', unit: 'bytesPerSecond', field: 'netTxBps' },
};

/** The measured values themselves. Every field is optional by design. */
export interface ResourceValues {
  cpuPercent?: number;
  memoryBytes?: number;
  diskReadBps?: number;
  diskWriteBps?: number;
  netRxBps?: number;
  netTxBps?: number;
}

/** A sub-unit of a sample: one compose container, typically. */
export interface ResourceChildSample extends ResourceValues {
  id: string;
  name: string;
  memoryLimitBytes?: number;
}

/** What the monitor stores per service and ships to the browser. */
export interface ResourceSample extends ResourceValues {
  /** Capture time of this sample. */
  at: string;
  /**
   * What the numbers are attributed to, in the provider's own words — e.g.
   * "systemd cgroup" versus "main PID only". Shown in the UI so nobody has to
   * guess whether child processes are included.
   */
  attribution: string;
  memoryLimitBytes?: number;
  /** Per-container / per-process breakdown, when the provider has one. */
  children?: ResourceChildSample[];
}

/**
 * Cumulative counters as read from the backend. Rates are derived from the
 * difference between two of these; providers never compute rates themselves.
 */
export interface ResourceCounters {
  cpuNanos?: number;
  diskReadBytes?: number;
  diskWriteBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
}

/** One measured entity in a provider sample: the service, or one of its children. */
export interface ProviderSampleUnit {
  /** Instantaneous CPU percentage, when the backend already computes one. */
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  counters?: ResourceCounters;
}

/** What `provider.sample()` returns. `null` means "nothing to measure". */
export interface ProviderSample extends ProviderSampleUnit {
  attribution: string;
  children?: (ProviderSampleUnit & { id: string; name: string })[];
}

/** Per-service counter memory, kept by the monitor between ticks. */
export interface CounterState {
  at: number;
  root: ResourceCounters;
  children: Map<string, ResourceCounters>;
}

/**
 * Rates from two counter readings.
 *
 * Guards, all of which happen in practice:
 *  - a counter that went backwards means the unit restarted, so the rate for
 *    that window is unknowable rather than negative;
 *  - a zero or negative time delta (two samples in the same millisecond, a
 *    clock step) would divide by ~0 and produce an absurd spike.
 */
export function deriveRates(previous: ResourceCounters, current: ResourceCounters, dtMs: number): ResourceValues {
  const values: ResourceValues = {};
  if (!Number.isFinite(dtMs) || dtMs <= 0) return values;

  const cpuDelta = delta(previous.cpuNanos, current.cpuNanos);
  if (cpuDelta !== undefined) {
    // nanoseconds of CPU time per millisecond of wall clock, as a percentage.
    values.cpuPercent = round2((cpuDelta / 1_000_000 / dtMs) * 100);
  }

  const rate = (from?: number, to?: number): number | undefined => {
    const bytes = delta(from, to);
    return bytes === undefined ? undefined : Math.round((bytes / dtMs) * 1_000);
  };

  const diskRead = rate(previous.diskReadBytes, current.diskReadBytes);
  if (diskRead !== undefined) values.diskReadBps = diskRead;
  const diskWrite = rate(previous.diskWriteBytes, current.diskWriteBytes);
  if (diskWrite !== undefined) values.diskWriteBps = diskWrite;
  const netRx = rate(previous.netRxBytes, current.netRxBytes);
  if (netRx !== undefined) values.netRxBps = netRx;
  const netTx = rate(previous.netTxBytes, current.netTxBytes);
  if (netTx !== undefined) values.netTxBps = netTx;

  return values;
}

function delta(from?: number, to?: number): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  if (to < from) return undefined; // counter reset (service restarted)
  return to - from;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sums the counters of several units, for provider-side aggregation. */
export function sumCounters(units: ProviderSampleUnit[]): ResourceCounters | undefined {
  const keys: (keyof ResourceCounters)[] = [
    'cpuNanos',
    'diskReadBytes',
    'diskWriteBytes',
    'netRxBytes',
    'netTxBytes',
  ];
  const total: ResourceCounters = {};
  let any = false;
  for (const key of keys) {
    let sum: number | undefined;
    for (const unit of units) {
      const value = unit.counters?.[key];
      if (value === undefined) continue;
      sum = (sum ?? 0) + value;
    }
    if (sum !== undefined) {
      total[key] = sum;
      any = true;
    }
  }
  return any ? total : undefined;
}

/** Sums a gauge across units, returning undefined when nobody reported it. */
export function sumGauge(units: ProviderSampleUnit[], key: 'cpuPercent' | 'memoryBytes'): number | undefined {
  let sum: number | undefined;
  for (const unit of units) {
    const value = unit[key];
    if (value === undefined) continue;
    sum = (sum ?? 0) + value;
  }
  return sum === undefined ? undefined : round2(sum);
}

/**
 * Quantized digest of a sample, used to decide whether an update is worth
 * pushing to the browser. Raw samples wobble on every tick; without this the
 * dashboard would receive a full service update every interval for every
 * service and re-render numbers nobody can read at that resolution.
 */
export function resourceDigest(sample: ResourceSample | null): string {
  if (!sample) return 'none';
  // Children are digested too: the drawer shows per-container numbers, and they
  // are only refreshed by an emitted update.
  const children = (sample.children ?? []).map((child) => `${child.id}=${valueDigest(child)}`);
  return [valueDigest(sample), sample.attribution, ...children].join('|');
}

function valueDigest(values: ResourceValues): string {
  const step = 1024 * 1024; // 1 MiB/s steps for the rates
  return [
    quantize(values.cpuPercent, 5), // 5 % steps
    quantize(values.memoryBytes, 32 * 1024 * 1024), // 32 MiB steps
    quantize(values.diskReadBps, step),
    quantize(values.diskWriteBps, step),
    quantize(values.netRxBps, step),
    quantize(values.netTxBps, step),
  ].join(',');
}

function quantize(value: number | undefined, step: number): string {
  if (value === undefined) return '-';
  return String(Math.round(value / step));
}

/** True when a sample carries at least one measured value. */
export function hasValues(values: ResourceValues): boolean {
  return RESOURCE_METRICS.some((metric) => values[RESOURCE_METRIC_INFO[metric].field] !== undefined);
}
