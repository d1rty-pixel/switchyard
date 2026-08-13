import {
  RESOURCE_METRICS,
  RESOURCE_METRIC_INFO,
  type ResourceChildSample,
  type ResourceMetric,
  type ResourceSample,
  type ResourceUnit,
} from './resources.js';
import type { AlertSeverity, MetricBreach, ResourceAlert } from './alerts.js';
import type { ResolvedMonitoring, ResolvedThreshold } from '../config/monitoring.js';
import type { ServiceState } from '../types.js';

/**
 * The resource projection behind `GET /api/resources`.
 *
 * The service summary already carries the latest sample, but answering "is
 * anything over its limits?" from it takes one request per service to fetch the
 * thresholds, and the numbers arrive without units, without an age and without
 * any way to see a breach that has started but not yet activated an alert. This
 * puts measurement, unit, threshold and threshold *state* in one place.
 *
 * Absent stays absent. A metric the provider cannot attribute to the service is
 * reported in `unmeasured`, never as a zero — systemd has no per-unit network
 * accounting, and a service with no network measurement is not a service with no
 * network traffic.
 */

export type ThresholdState =
  /** Above the critical threshold, for long enough that an alert is active. */
  | 'critical'
  /** Above the warning threshold, alert active. */
  | 'warning'
  /** Above a threshold, but `for` has not elapsed yet — no alert yet. */
  | 'pending'
  /** Measured and below every configured threshold. */
  | 'ok'
  /** Measured, but this metric has no threshold configured. */
  | 'no-threshold'
  /** Not measurable for this service, or nothing sampled yet. */
  | 'unmeasured';

/** Why a service may be showing no numbers. */
export type SamplingState =
  /** Sampled normally. */
  | 'ok'
  /** Sampling is switched off for this service, or its provider cannot sample. */
  | 'off'
  /** An action is running; measuring a restart would be meaningless. */
  | 'paused'
  /** Sampling is on, but there is nothing to measure (typically stopped). */
  | 'no-sample';

export interface ResourceMetricView {
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
  /** Measured value. Absent when this metric is not measurable here. */
  value?: number;
  state: ThresholdState;
  warning?: number;
  critical?: number;
  /** How long a breach must last before it alerts. */
  forMs?: number;
  /** Value as a percentage of each threshold, for headroom at a glance. */
  percentOfWarning?: number;
  percentOfCritical?: number;
  /** Set while `state` is `pending`. */
  pendingSeverity?: AlertSeverity;
  breachingForMs?: number;
  activatesInMs?: number;
  /** Key of the active alert for this metric, when there is one. */
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
  /** Capture time of the sample these numbers come from. */
  sampledAt?: string;
  /** Age of that sample; a large value means the numbers are stale. */
  ageMs?: number;
  /** What the numbers cover, in the provider's own words. */
  attribution?: string;
  metrics: ResourceMetricView[];
  /** Metrics with no measurement — explicitly not zero. */
  unmeasured: ResourceMetric[];
  memory?: { bytes: number; limitBytes?: number; percentOfLimit?: number };
  alerts: ResourceAlert[];
  /** Per-container breakdown, where the provider reports one. */
  children?: ChildResourceView[];
  /** Worst threshold state across this service's metrics, for sorting. */
  worst: ThresholdState;
  /** Retained history samples, i.e. how much trend data a query would see. */
  historySamples: number;
}

export interface ResourceViewInput {
  id: string;
  name: string;
  type: string;
  providerLabel: string;
  group: string;
  state: ServiceState;
  /** Sampling is on for this service *and* its provider can sample. */
  monitored: boolean;
  /** True while an action runs. */
  busy: boolean;
  monitoring: ResolvedMonitoring;
  sample: ResourceSample | null;
  alerts: ResourceAlert[];
  pending: Partial<Record<ResourceMetric, MetricBreach>>;
  historySamples: number;
  now: number;
}

export function buildResourceView(input: ResourceViewInput): ServiceResourceView {
  const { sample, monitoring } = input;
  const alertByMetric = new Map(input.alerts.map((alert) => [alert.metric, alert]));

  const metrics: ResourceMetricView[] = [];
  const unmeasured: ResourceMetric[] = [];

  for (const metric of RESOURCE_METRICS) {
    const info = RESOURCE_METRIC_INFO[metric];
    const value = sample?.[info.field];
    const threshold = monitoring.thresholds[metric];

    if (value === undefined) {
      unmeasured.push(metric);
      // A threshold on an unmeasured metric is worth reporting: it explains why
      // a configured limit never fires.
      if (threshold) {
        metrics.push({
          metric,
          label: info.label,
          unit: info.unit,
          state: 'unmeasured',
          ...thresholdFields(threshold),
        });
      }
      continue;
    }

    metrics.push({
      metric,
      label: info.label,
      unit: info.unit,
      value,
      ...thresholdFields(threshold),
      ...percentages(value, threshold),
      ...stateFields(threshold, alertByMetric.get(metric), input.pending[metric], input.now),
    });
  }

  const view: ServiceResourceView = {
    id: input.id,
    name: input.name,
    type: input.type,
    providerLabel: input.providerLabel,
    group: input.group,
    state: input.state,
    monitored: input.monitored,
    sampling: samplingState(input),
    metrics,
    unmeasured,
    alerts: input.alerts,
    worst: worstState(metrics),
    historySamples: input.historySamples,
  };

  if (sample) {
    view.sampledAt = sample.at;
    view.ageMs = Math.max(0, input.now - Date.parse(sample.at));
    view.attribution = sample.attribution;
    if (sample.memoryBytes !== undefined) {
      view.memory = memoryView(sample.memoryBytes, sample.memoryLimitBytes);
    }
    if (sample.children && sample.children.length > 0) {
      view.children = sample.children.map(childView);
    }
  }

  return view;
}

function samplingState(input: ResourceViewInput): SamplingState {
  if (!input.monitored) return 'off';
  if (input.busy) return 'paused';
  return input.sample ? 'ok' : 'no-sample';
}

function thresholdFields(threshold?: ResolvedThreshold): Partial<ResourceMetricView> {
  if (!threshold) return {};
  const fields: Partial<ResourceMetricView> = { forMs: threshold.forMs };
  if (threshold.warning !== undefined) fields.warning = threshold.warning;
  if (threshold.critical !== undefined) fields.critical = threshold.critical;
  return fields;
}

function percentages(value: number, threshold?: ResolvedThreshold): Partial<ResourceMetricView> {
  const fields: Partial<ResourceMetricView> = {};
  if (threshold?.warning) fields.percentOfWarning = round1((value / threshold.warning) * 100);
  if (threshold?.critical) fields.percentOfCritical = round1((value / threshold.critical) * 100);
  return fields;
}

/**
 * An active alert is authoritative about severity — it is the alert machine's own
 * verdict, including hysteresis and de-escalation. Only when no alert exists does
 * a pending crossing decide the state.
 */
function stateFields(
  threshold: ResolvedThreshold | undefined,
  alert: ResourceAlert | undefined,
  pending: MetricBreach | undefined,
  now: number,
): Pick<ResourceMetricView, 'state'> & Partial<ResourceMetricView> {
  if (alert) return { state: alert.severity, alertKey: alert.key };
  if (!threshold) return { state: 'no-threshold' };
  if (pending) {
    const breachingForMs = Math.max(0, now - pending.since);
    return {
      state: 'pending',
      pendingSeverity: pending.severity,
      breachingForMs,
      activatesInMs: Math.max(0, threshold.forMs - breachingForMs),
    };
  }
  return { state: 'ok' };
}

const STATE_RANK: Record<ThresholdState, number> = {
  critical: 5,
  warning: 4,
  pending: 3,
  ok: 2,
  'no-threshold': 1,
  unmeasured: 0,
};

function worstState(metrics: ResourceMetricView[]): ThresholdState {
  let worst: ThresholdState = 'unmeasured';
  for (const metric of metrics) {
    if (STATE_RANK[metric.state] > STATE_RANK[worst]) worst = metric.state;
  }
  return worst;
}

function memoryView(bytes: number, limitBytes?: number): NonNullable<ServiceResourceView['memory']> {
  const memory: NonNullable<ServiceResourceView['memory']> = { bytes };
  if (limitBytes !== undefined && limitBytes > 0) {
    memory.limitBytes = limitBytes;
    memory.percentOfLimit = round1((bytes / limitBytes) * 100);
  }
  return memory;
}

function childView(child: ResourceChildSample): ChildResourceView {
  const view: ChildResourceView = { ...child };
  if (child.memoryBytes !== undefined && child.memoryLimitBytes) {
    view.percentOfMemoryLimit = round1((child.memoryBytes / child.memoryLimitBytes) * 100);
  }
  return view;
}

/** Ordering for `?sort=` — highest value of one metric first, unmeasured last. */
export function sortByMetric(views: ServiceResourceView[], metric: ResourceMetric): ServiceResourceView[] {
  const valueOf = (view: ServiceResourceView): number | undefined =>
    view.metrics.find((entry) => entry.metric === metric)?.value;
  return [...views].sort((a, b) => {
    const left = valueOf(a);
    const right = valueOf(b);
    if (left === undefined && right === undefined) return a.id.localeCompare(b.id);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left || a.id.localeCompare(b.id);
  });
}

/** Default ordering: worst threshold state first, then by id. */
export function sortBySeverity(views: ServiceResourceView[]): ServiceResourceView[] {
  return [...views].sort(
    (a, b) => STATE_RANK[b.worst] - STATE_RANK[a.worst] || a.id.localeCompare(b.id),
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
