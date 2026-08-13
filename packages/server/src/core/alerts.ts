import { RESOURCE_METRICS, RESOURCE_METRIC_INFO, type ResourceMetric, type ResourceUnit, type ResourceValues } from './resources.js';
import type { ResolvedMonitoring, ResolvedThreshold } from '../config/monitoring.js';

/**
 * Resource alert state machine.
 *
 * Deliberately pure: it takes values, a configuration and the current time, and
 * returns state transitions. No timers, no I/O, no `Date.now()` — which is what
 * makes flapping, escalation and cooldown testable without waiting in real time.
 *
 * All durations are elapsed wall-clock milliseconds. Nothing counts samples, so
 * changing `monitoring.interval` changes how *often* the machine is asked, never
 * what `for: 30s` means.
 */

export type AlertSeverity = 'warning' | 'critical';

export interface ResourceAlert {
  /** Stable identity of an alert: one per service and metric. */
  key: string;
  serviceId: string;
  serviceName: string;
  metric: ResourceMetric;
  label: string;
  unit: ResourceUnit;
  severity: AlertSeverity;
  /** Most recent measured value. */
  value: number;
  /** Threshold of the current severity. */
  threshold: number;
  /** When the breach that led to this alert started. */
  breachedAt: string;
  /** When the alert became active (i.e. when `for` had elapsed). */
  activatedAt: string;
  updatedAt: string;
  active: boolean;
  clearedAt?: string;
  /** True while no fresh samples are arriving for an otherwise active alert. */
  stale?: boolean;
}

export type AlertEventKind = 'activated' | 'escalated' | 'deescalated' | 'cleared';

export interface AlertEvent {
  kind: AlertEventKind;
  alert: ResourceAlert;
  /**
   * Whether this transition is worth interrupting the user for. False for
   * cosmetic transitions and for repeats suppressed by the cooldown, so the
   * delivery layer never has to reimplement the dedup rules.
   */
  notify: boolean;
  /** Short human explanation, used for the notification body. */
  reason: string;
}

interface Tracked {
  active?: ResourceAlert;
  /** When each severity's threshold started being exceeded, if it currently is. */
  pending: Partial<Record<AlertSeverity, number>>;
  /** Last time a value for this metric was actually observed. */
  lastSeenAt?: number;
  lastNotifiedAt?: number;
  /**
   * When an escalation of the *current* activation was last notified. A value
   * bouncing across the critical threshold escalates and de-escalates over and
   * over; only the first crossing is news, the rest are rate-limited.
   */
  lastEscalationNotifiedAt?: number;
  /** Whether the current activation produced a notification. */
  notifiedActive: boolean;
}

export interface EvaluateInput {
  serviceId: string;
  serviceName: string;
  /** Measured values, or null when this tick produced no sample at all. */
  values: ResourceValues | null;
  monitoring: ResolvedMonitoring;
  now: number;
  /**
   * True while an action runs for the service. The machine then holds its state:
   * a restart is not a breach recovery, and a `docker compose up` is not a spike
   * worth alerting on.
   */
  paused?: boolean;
  /** How long an active alert survives without fresh samples before clearing. */
  staleAfterMs: number;
}

export class AlertTracker {
  private states = new Map<string, Tracked>();

  /** Feeds one sample in and returns the resulting transitions. */
  evaluate(input: EvaluateInput): AlertEvent[] {
    const events: AlertEvent[] = [];
    const { monitoring, now } = input;

    for (const metric of RESOURCE_METRICS) {
      const threshold = monitoring.thresholds[metric];
      const key = `${input.serviceId}:${metric}`;

      if (!threshold || !monitoring.enabled) {
        // Configuration removed the threshold: drop any alert it left behind.
        const existing = this.states.get(key);
        if (existing?.active) {
          events.push(this.clear(existing, now, 'monitoring disabled for this metric'));
        }
        this.states.delete(key);
        continue;
      }

      const state = this.states.get(key) ?? { pending: {}, notifiedActive: false };
      this.states.set(key, state);

      if (input.paused) {
        // Hold: forget partial breaches, and do not let the staleness clock run.
        state.pending = {};
        state.lastSeenAt = now;
        continue;
      }

      const value = input.values?.[RESOURCE_METRIC_INFO[metric].field];

      if (value === undefined) {
        state.pending = {};
        if (state.active) {
          const since = state.lastSeenAt ?? now;
          if (now - since >= input.staleAfterMs) {
            events.push(this.clear(state, now, 'no resource samples for this service any more'));
          } else if (!state.active.stale) {
            state.active.stale = true;
            state.active.updatedAt = new Date(now).toISOString();
          }
        }
        continue;
      }

      state.lastSeenAt = now;
      const event = this.step(input, metric, threshold, state, value, key);
      if (event) events.push(event);
    }

    return events;
  }

  private step(
    input: EvaluateInput,
    metric: ResourceMetric,
    threshold: ResolvedThreshold,
    state: Tracked,
    value: number,
    key: string,
  ): AlertEvent | undefined {
    const { now, monitoring } = input;
    const iso = new Date(now).toISOString();

    // Track, per severity, since when its threshold has been exceeded.
    for (const severity of ['warning', 'critical'] as const) {
      const limit = threshold[severity];
      if (limit === undefined) {
        delete state.pending[severity];
        continue;
      }
      if (value >= limit) state.pending[severity] ??= now;
      else delete state.pending[severity];
    }

    const qualified = (severity: AlertSeverity): boolean => {
      const since = state.pending[severity];
      return since !== undefined && now - since >= threshold.forMs;
    };
    const target: AlertSeverity | undefined = qualified('critical')
      ? 'critical'
      : qualified('warning')
        ? 'warning'
        : undefined;

    if (!state.active) {
      if (!target) return undefined;
      const limit = threshold[target] as number;
      const notify = state.lastNotifiedAt === undefined || now - state.lastNotifiedAt >= monitoring.cooldownMs;
      const alert: ResourceAlert = {
        key,
        serviceId: input.serviceId,
        serviceName: input.serviceName,
        metric,
        label: RESOURCE_METRIC_INFO[metric].label,
        unit: threshold.unit,
        severity: target,
        value,
        threshold: limit,
        breachedAt: new Date(state.pending[target] ?? now).toISOString(),
        activatedAt: iso,
        updatedAt: iso,
        active: true,
      };
      state.active = alert;
      state.notifiedActive = notify;
      if (notify) state.lastNotifiedAt = now;
      return {
        kind: 'activated',
        alert: { ...alert },
        notify,
        reason: notify
          ? `above ${format(limit, threshold.unit)} for ${Math.round(threshold.forMs / 1000)}s`
          : 'repeat breach within the notification cooldown',
      };
    }

    const active = state.active;
    active.value = value;
    active.updatedAt = iso;
    if (active.stale) active.stale = false;

    // Re-read the threshold from the configuration on every tick. A reload may
    // have moved it — raising a threshold that turned out to be too low is the
    // most common reason to edit one — and both the clearing comparison below and
    // the number shown in the UI have to follow the current config, not the one
    // that happened to be in force when the alert activated.
    const activeLimit = threshold[active.severity];
    if (activeLimit !== undefined) {
      active.threshold = activeLimit;
    } else {
      // That severity no longer exists in the config. The other one must (the
      // schema requires at least one), so fall back to it rather than keeping a
      // threshold nothing can clear against.
      const fallbackSeverity: AlertSeverity = active.severity === 'critical' ? 'warning' : 'critical';
      const fallbackLimit = threshold[fallbackSeverity];
      if (fallbackLimit !== undefined) {
        active.severity = fallbackSeverity;
        active.threshold = fallbackLimit;
      }
    }

    // Escalation: warning already active and the critical threshold qualified.
    if (target === 'critical' && active.severity === 'warning') {
      const limit = threshold.critical as number;
      active.severity = 'critical';
      active.threshold = limit;
      // `breachedAt` keeps pointing at the start of the *breach*, not at the
      // start of the current severity — escalating and de-escalating a
      // continuous breach must not make its start time move around.
      //
      // The first escalation is news and is reported regardless of the cooldown;
      // repeated crossings of the same threshold are rate-limited like repeated
      // activations, so a value parked on the critical line cannot produce a
      // notification every time it wobbles.
      const notify =
        state.lastEscalationNotifiedAt === undefined ||
        now - state.lastEscalationNotifiedAt >= monitoring.cooldownMs;
      if (notify) {
        state.notifiedActive = true;
        state.lastNotifiedAt = now;
        state.lastEscalationNotifiedAt = now;
      }
      return {
        kind: 'escalated',
        alert: { ...active },
        notify,
        reason: notify
          ? `now above the critical threshold ${format(limit, threshold.unit)}`
          : 'repeat escalation within the notification cooldown',
      };
    }

    const criticalLimit = threshold.critical;
    const warningLimit = threshold.warning;

    if (active.severity === 'critical' && criticalLimit !== undefined) {
      if (value >= criticalLimit * monitoring.clearBelow) return undefined;
      // Critical relieved. Stay active at warning level while that threshold is
      // still breached — dropping straight to "cleared" would report a recovery
      // that has not happened.
      if (warningLimit !== undefined && value >= warningLimit * monitoring.clearBelow) {
        active.severity = 'warning';
        active.threshold = warningLimit;
        return {
          kind: 'deescalated',
          alert: { ...active },
          notify: false,
          reason: `back below the critical threshold ${format(criticalLimit, threshold.unit)}`,
        };
      }
      return this.clear(state, now, `recovered below ${format(criticalLimit * monitoring.clearBelow, threshold.unit)}`);
    }

    const limit = active.threshold;
    if (value < limit * monitoring.clearBelow) {
      return this.clear(state, now, `recovered below ${format(limit * monitoring.clearBelow, threshold.unit)}`);
    }
    return undefined;
  }

  private clear(state: Tracked, now: number, reason: string): AlertEvent {
    const active = state.active as ResourceAlert;
    const cleared: ResourceAlert = {
      ...active,
      active: false,
      clearedAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    delete cleared.stale;
    state.active = undefined;
    state.pending = {};
    delete state.lastEscalationNotifiedAt;
    // A recovery is only interesting if the breach itself was reported.
    const notify = state.notifiedActive;
    state.notifiedActive = false;
    return { kind: 'cleared', alert: cleared, notify, reason };
  }

  /** Active alerts for one service, in severity order. */
  activeFor(serviceId: string): ResourceAlert[] {
    const alerts: ResourceAlert[] = [];
    for (const metric of RESOURCE_METRICS) {
      const active = this.states.get(`${serviceId}:${metric}`)?.active;
      if (active) alerts.push({ ...active });
    }
    return alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  }

  /** Every active alert, across all services. */
  active(): ResourceAlert[] {
    const alerts: ResourceAlert[] = [];
    for (const state of this.states.values()) {
      if (state.active) alerts.push({ ...state.active });
    }
    return alerts.sort(
      (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.key.localeCompare(b.key),
    );
  }

  /**
   * Drops all state for a service — used when it disappears from the config.
   * Returns clear events for whatever was still active, so the UI does not keep
   * showing an alert for a service that no longer exists.
   */
  forget(serviceId: string, now: number): AlertEvent[] {
    const events: AlertEvent[] = [];
    for (const metric of RESOURCE_METRICS) {
      const key = `${serviceId}:${metric}`;
      const state = this.states.get(key);
      if (!state) continue;
      if (state.active) events.push(this.clear(state, now, 'service is no longer configured'));
      this.states.delete(key);
    }
    return events;
  }
}

function severityRank(severity: AlertSeverity): number {
  return severity === 'critical' ? 2 : 1;
}

/** Threshold rendering for messages; the UI formats values on its own. */
export function format(value: number, unit: ResourceUnit): string {
  switch (unit) {
    case 'percent':
      return `${round(value)}%`;
    case 'bytes':
      return formatBytes(value);
    case 'bytesPerSecond':
      return `${formatBytes(value)}/s`;
  }
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${round(size)} ${units[unit]}`;
}

function round(value: number): number {
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

/** Digest used to suppress no-op service updates; see `resourceDigest`. */
export function alertDigest(alerts: ResourceAlert[]): string {
  if (alerts.length === 0) return 'none';
  return alerts
    .map((alert) => `${alert.metric}:${alert.severity}:${alert.activatedAt}:${alert.stale ? 'stale' : 'live'}`)
    .join(',');
}
