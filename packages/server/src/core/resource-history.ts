import { RESOURCE_METRICS, RESOURCE_METRIC_INFO, type ResourceMetric, type ResourceValues } from './resources.js';
import type { ResolvedThreshold } from '../config/monitoring.js';

/**
 * Bounded in-memory history of resource samples.
 *
 * Exists to answer one question the latest sample cannot: *sustained* load
 * versus a spike. `ServiceRecord.resources` holds one reading, so a service at
 * 200 % CPU right now looks identical whether it has been there for ten minutes
 * or ten seconds.
 *
 * Deliberately in memory only. Action history is persisted because it records
 * something a person did; samples are a live projection of the machine, and
 * writing 6 numbers per service every 15 s to disk buys nothing this tool needs.
 * A restart starts a fresh window, which the API reports as a short `spanMs`.
 *
 * Only root values are kept, never the per-container breakdown: children
 * multiply the retained set by the size of a compose project for a view nothing
 * asks of history. `/api/resources` still carries the current per-child sample.
 */

/** One retained reading. Root values only; absent metrics stay absent. */
export interface HistorySample {
  /** Epoch milliseconds, so trimming and bucketing need no date parsing. */
  at: number;
  values: ResourceValues;
}

/**
 * Hard per-service cap, independent of the configured retention. At the 2 s
 * floor for `monitoring.interval`, 30 minutes of samples would be 900 readings;
 * this leaves headroom for that without letting a `history: 24h` on a fast
 * interval grow without limit. Whichever bound bites first wins, and the API
 * reports the span actually covered rather than the span requested.
 */
export const MAX_HISTORY_SAMPLES = 2_000;

export class ResourceHistory {
  private series = new Map<string, HistorySample[]>();

  constructor(private retentionMs: number) {}

  get retention(): number {
    return this.retentionMs;
  }

  /** Applies a new retention window (config reload); trims on the next append. */
  reconfigure(retentionMs: number): void {
    this.retentionMs = retentionMs;
    for (const id of this.series.keys()) this.trim(id, Date.now());
  }

  /**
   * Records one reading. Samples carrying no measured value at all are dropped:
   * a stopped service would otherwise fill the window with empty readings that
   * dilute every average computed over it.
   */
  append(id: string, at: number, values: ResourceValues): void {
    if (!hasAnyValue(values)) return;
    const list = this.series.get(id) ?? [];
    list.push({ at, values: pickValues(values) });
    this.series.set(id, list);
    this.trim(id, at);
  }

  /** Drops everything for a service — reload removed it, or its provider changed. */
  forget(id: string): void {
    this.series.delete(id);
  }

  /** Retained samples for a service, oldest first, optionally windowed. */
  samples(id: string, windowMs?: number, now = Date.now()): HistorySample[] {
    const list = this.series.get(id);
    if (!list || list.length === 0) return [];
    if (windowMs === undefined) return [...list];
    const from = now - windowMs;
    return list.filter((sample) => sample.at >= from);
  }

  /** Number of retained samples, for diagnostics. */
  size(id: string): number {
    return this.series.get(id)?.length ?? 0;
  }

  private trim(id: string, now: number): void {
    const list = this.series.get(id);
    if (!list) return;
    const from = now - this.retentionMs;
    let start = 0;
    while (start < list.length && (list[start] as HistorySample).at < from) start += 1;
    if (list.length - start > MAX_HISTORY_SAMPLES) start = list.length - MAX_HISTORY_SAMPLES;
    if (start > 0) list.splice(0, start);
    if (list.length === 0) this.series.delete(id);
  }
}

/** Copies only the six known metric fields, so nothing else is retained. */
function pickValues(values: ResourceValues): ResourceValues {
  const copy: ResourceValues = {};
  for (const metric of RESOURCE_METRICS) {
    const field = RESOURCE_METRIC_INFO[metric].field;
    const value = values[field];
    if (value !== undefined) copy[field] = value;
  }
  return copy;
}

function hasAnyValue(values: ResourceValues): boolean {
  return RESOURCE_METRICS.some((metric) => values[RESOURCE_METRIC_INFO[metric].field] !== undefined);
}

// ── statistics ────────────────────────────────────────────────────────────────

/** Everything derived for one metric over a history window. */
export interface MetricStats {
  metric: ResourceMetric;
  label: string;
  unit: string;
  /** Readings that actually carried this metric. */
  samples: number;
  min: number;
  max: number;
  average: number;
  /** Nearest-rank 95th percentile, not interpolated. */
  p95: number;
  latest: number;
  firstAt: string;
  lastAt: string;
  /** Time actually covered by those readings, not the requested window. */
  spanMs: number;
  /**
   * Share of the readings above each threshold, 0–1. This is what separates a
   * spike from sustained load: 0.05 above warning is a blip, 0.9 is a state.
   * Absent when the metric has no threshold of that severity configured.
   */
  fractionAboveWarning?: number;
  fractionAboveCritical?: number;
  warning?: number;
  critical?: number;
}

/**
 * Per-metric statistics over the given samples.
 *
 * Fractions are counted per reading rather than weighted by time. Sampling runs
 * on a fixed interval, so the two agree; counting is honest about what was
 * actually observed when a tick is skipped or a sample fails.
 */
export function metricStats(
  samples: HistorySample[],
  thresholds: Partial<Record<ResourceMetric, ResolvedThreshold>>,
): MetricStats[] {
  const stats: MetricStats[] = [];

  for (const metric of RESOURCE_METRICS) {
    const info = RESOURCE_METRIC_INFO[metric];
    const points = samples
      .map((sample) => ({ at: sample.at, value: sample.values[info.field] }))
      .filter((point): point is { at: number; value: number } => point.value !== undefined);
    if (points.length === 0) continue;

    const values = points.map((point) => point.value);
    const sorted = [...values].sort((a, b) => a - b);
    const first = points[0] as { at: number; value: number };
    const last = points[points.length - 1] as { at: number; value: number };
    const threshold = thresholds[metric];

    const entry: MetricStats = {
      metric,
      label: info.label,
      unit: info.unit,
      samples: points.length,
      min: round2(sorted[0] as number),
      max: round2(sorted[sorted.length - 1] as number),
      average: round2(values.reduce((sum, value) => sum + value, 0) / values.length),
      p95: round2(percentile(sorted, 0.95)),
      latest: round2(last.value),
      firstAt: new Date(first.at).toISOString(),
      lastAt: new Date(last.at).toISOString(),
      spanMs: last.at - first.at,
    };

    if (threshold?.warning !== undefined) {
      entry.warning = threshold.warning;
      entry.fractionAboveWarning = fractionAtOrAbove(values, threshold.warning);
    }
    if (threshold?.critical !== undefined) {
      entry.critical = threshold.critical;
      entry.fractionAboveCritical = fractionAtOrAbove(values, threshold.critical);
    }

    stats.push(entry);
  }

  return stats;
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/** Uses `>=` to match the alert machine, which breaches at the threshold. */
function fractionAtOrAbove(values: number[], threshold: number): number {
  const over = values.filter((value) => value >= threshold).length;
  return Math.round((over / values.length) * 1000) / 1000;
}

// ── bucketing ─────────────────────────────────────────────────────────────────

export interface HistoryBucket {
  at: string;
  endAt: string;
  samples: number;
  /** Average and peak per metric inside the bucket; absent metrics stay absent. */
  values: Partial<Record<ResourceMetric, { average: number; max: number }>>;
}

/**
 * Downsamples samples into a fixed number of equal time buckets.
 *
 * Fixed count, not fixed width: the series stays the same size whether the
 * window is 5 minutes or 24 hours, which is what keeps a `window: 24h` request
 * from returning thousands of points to an agent that asked one question. Both
 * the average and the max are kept per bucket — averaging alone would hide the
 * spike the caller may be looking for.
 */
export function bucketSamples(
  samples: HistorySample[],
  buckets: number,
  from: number,
  to: number,
): HistoryBucket[] {
  if (samples.length === 0 || buckets <= 0 || to <= from) return [];
  const width = (to - from) / buckets;
  const out: HistoryBucket[] = [];

  for (let index = 0; index < buckets; index += 1) {
    const start = from + index * width;
    const end = index === buckets - 1 ? to : start + width;
    // Half-open [start, end), except the last bucket which includes `to` so the
    // newest sample can never fall outside every bucket.
    const inside = samples.filter((sample) =>
      index === buckets - 1 ? sample.at >= start && sample.at <= end : sample.at >= start && sample.at < end,
    );
    if (inside.length === 0) continue;

    const values: HistoryBucket['values'] = {};
    for (const metric of RESOURCE_METRICS) {
      const field = RESOURCE_METRIC_INFO[metric].field;
      const numbers = inside
        .map((sample) => sample.values[field])
        .filter((value): value is number => value !== undefined);
      if (numbers.length === 0) continue;
      values[metric] = {
        average: round2(numbers.reduce((sum, value) => sum + value, 0) / numbers.length),
        max: round2(Math.max(...numbers)),
      };
    }

    out.push({
      at: new Date(Math.round(start)).toISOString(),
      endAt: new Date(Math.round(end)).toISOString(),
      samples: inside.length,
      values,
    });
  }

  return out;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
