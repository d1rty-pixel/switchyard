import { z } from 'zod';
import { RESOURCE_METRICS, RESOURCE_METRIC_INFO, type ResourceMetric, type ResourceUnit } from '../core/resources.js';
import { bytesSchema, durationSchema, percentSchema, rateSchema, ratioSchema } from './units.js';

/**
 * Resource monitoring configuration: global defaults in `switchyard.yaml`,
 * per-service overrides in the service file.
 *
 * ```yaml
 * # switchyard.yaml
 * monitoring:
 *   interval: 15s          # how often samples are taken
 *   for: 30s               # default sustained-breach duration
 *   clearBelow: 0.9        # hysteresis factor for clearing
 *   cooldown: 5m           # minimum gap between repeat notifications
 *   history: 30m           # how long samples are kept for trend queries
 *
 * # services.d/antivirus.yaml
 * monitoring:
 *   cpu:
 *     warning: 150%
 *     critical: 400%
 *     for: 30s
 *   memory:
 *     warning: 2GiB
 *     critical: 4GiB
 *     for: 1m
 *   diskWrite:
 *     warning: 50MiB/s
 * ```
 *
 * Thresholds are what turn sampling into alerting: a service with no thresholds
 * is still sampled (so the dashboard shows its usage) but can never alert.
 */

/** The unit each metric's thresholds are written in. */
const METRIC_SCHEMAS: Record<ResourceUnit, z.ZodType<number, z.ZodTypeDef, unknown>> = {
  percent: percentSchema,
  bytes: bytesSchema,
  bytesPerSecond: rateSchema,
};

function thresholdSchema(unit: ResourceUnit) {
  const value = METRIC_SCHEMAS[unit];
  return z
    .object({
      warning: value.optional(),
      critical: value.optional(),
      /** How long the threshold must stay exceeded before the alert activates. */
      for: durationSchema.optional(),
    })
    .strict()
    .superRefine((entry, context) => {
      if (entry.warning === undefined && entry.critical === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'needs a warning or a critical threshold' });
      }
      if (entry.warning !== undefined && entry.critical !== undefined && entry.critical < entry.warning) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'critical must not be lower than warning',
        });
      }
    });
}

const metricThresholds = Object.fromEntries(
  RESOURCE_METRICS.map((metric) => [metric, thresholdSchema(RESOURCE_METRIC_INFO[metric].unit).optional()]),
) as { [M in ResourceMetric]: z.ZodOptional<ReturnType<typeof thresholdSchema>> };

/** Knobs shared by the global block and every service block. */
const commonSchema = {
  /** Sample and alert on this service at all. */
  enabled: z.boolean().optional(),
  /** Default sustained duration for metrics that do not set their own. */
  for: durationSchema.optional(),
  /**
   * Clear factor: with 0.9, a threshold of 100 only clears once the value drops
   * below 90. Without this, a value hovering at the threshold flaps.
   */
  clearBelow: ratioSchema.optional(),
  /** Minimum gap between repeat notifications for the same service + metric. */
  cooldown: durationSchema.optional(),
};

export const globalMonitoringSchema = z
  .object({
    ...commonSchema,
    /** How often samples are collected. Independent of the status poll. */
    interval: durationSchema.optional(),
    /**
     * How far back resource samples are kept in memory, for trend queries.
     * Global only: retention is a storage bound, not a per-service policy.
     */
    history: durationSchema.optional(),
    ...metricThresholds,
  })
  .strict()
  .optional();

export const serviceMonitoringSchema = z
  .object({ ...commonSchema, ...metricThresholds })
  .strict()
  .optional();

export type GlobalMonitoringInput = z.infer<typeof globalMonitoringSchema>;
export type ServiceMonitoringInput = z.infer<typeof serviceMonitoringSchema>;

/** Defaults, chosen to be useful without any monitoring block in the config. */
export const MONITORING_DEFAULTS = {
  enabled: true,
  intervalMs: 15_000,
  forMs: 30_000,
  clearBelow: 0.9,
  cooldownMs: 300_000,
  historyMs: 1_800_000,
} as const;

/** Sampling interval bounds. Anything faster than 2 s just spawns processes. */
export const MIN_INTERVAL_MS = 2_000;
export const MAX_INTERVAL_MS = 3_600_000;

/**
 * Retention bounds for the in-memory sample history. The upper bound is a day
 * because retention is only ever a *time* request here — the per-service sample
 * cap in `core/resource-history.ts` is what actually bounds the memory.
 */
export const MIN_HISTORY_MS = 60_000;
export const MAX_HISTORY_MS = 86_400_000;

export interface ResolvedThreshold {
  warning?: number;
  critical?: number;
  /** Sustained duration in milliseconds — elapsed time, never sample counts. */
  forMs: number;
  unit: ResourceUnit;
}

/** Everything the alert machine needs for one service. */
export interface ResolvedMonitoring {
  enabled: boolean;
  clearBelow: number;
  cooldownMs: number;
  thresholds: Partial<Record<ResourceMetric, ResolvedThreshold>>;
}

export interface ResolvedGlobalMonitoring {
  enabled: boolean;
  intervalMs: number;
  forMs: number;
  clearBelow: number;
  cooldownMs: number;
  /** Retention window for the in-memory resource sample history. */
  historyMs: number;
  thresholds: Partial<Record<ResourceMetric, ResolvedThreshold>>;
}

export function resolveGlobalMonitoring(input: GlobalMonitoringInput): ResolvedGlobalMonitoring {
  const forMs = input?.for ?? MONITORING_DEFAULTS.forMs;
  const global: ResolvedGlobalMonitoring = {
    enabled: input?.enabled ?? MONITORING_DEFAULTS.enabled,
    intervalMs: clamp(input?.interval ?? MONITORING_DEFAULTS.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    forMs,
    clearBelow: input?.clearBelow ?? MONITORING_DEFAULTS.clearBelow,
    cooldownMs: input?.cooldown ?? MONITORING_DEFAULTS.cooldownMs,
    historyMs: clamp(input?.history ?? MONITORING_DEFAULTS.historyMs, MIN_HISTORY_MS, MAX_HISTORY_MS),
    thresholds: {},
  };
  for (const metric of RESOURCE_METRICS) {
    const entry = input?.[metric];
    if (!entry) continue;
    global.thresholds[metric] = toThreshold(metric, entry, forMs);
  }
  return global;
}

/**
 * Per-service configuration on top of the global defaults.
 *
 * Merge rules, deliberately boring:
 *  - `enabled`, `clearBelow`, `cooldown`: the service value wins if present.
 *  - thresholds: per metric, the service block *replaces* the global one — a
 *    service that sets only `warning` for a metric does not silently inherit a
 *    global `critical` that its author cannot see in the same file.
 *  - `for`: metric block, then service block, then global block, then default.
 */
export function resolveServiceMonitoring(
  global: ResolvedGlobalMonitoring,
  input: ServiceMonitoringInput,
): ResolvedMonitoring {
  const forMs = input?.for ?? global.forMs;
  const resolved: ResolvedMonitoring = {
    enabled: global.enabled && (input?.enabled ?? true),
    clearBelow: input?.clearBelow ?? global.clearBelow,
    cooldownMs: input?.cooldown ?? global.cooldownMs,
    thresholds: {},
  };

  for (const metric of RESOURCE_METRICS) {
    const entry = input?.[metric];
    if (entry) {
      resolved.thresholds[metric] = toThreshold(metric, entry, forMs);
      continue;
    }
    const inherited = global.thresholds[metric];
    // Inherited thresholds keep the global `for` unless the service set one.
    if (inherited) {
      resolved.thresholds[metric] = { ...inherited, forMs: input?.for ?? inherited.forMs };
    }
  }

  return resolved;
}

function toThreshold(
  metric: ResourceMetric,
  entry: { warning?: number; critical?: number; for?: number },
  fallbackForMs: number,
): ResolvedThreshold {
  const threshold: ResolvedThreshold = {
    forMs: entry.for ?? fallbackForMs,
    unit: RESOURCE_METRIC_INFO[metric].unit,
  };
  if (entry.warning !== undefined) threshold.warning = entry.warning;
  if (entry.critical !== undefined) threshold.critical = entry.critical;
  return threshold;
}

export function hasThresholds(monitoring: ResolvedMonitoring): boolean {
  return Object.keys(monitoring.thresholds).length > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
