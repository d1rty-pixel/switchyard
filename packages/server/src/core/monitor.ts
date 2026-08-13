import { AlertTracker, type AlertEvent, type ResourceAlert } from './alerts.js';
import { logger, type Logger } from './logger.js';
import { SampleBatch } from './sample-batch.js';
import {
  deriveRates,
  hasValues,
  type CounterState,
  type ProviderSample,
  type ProviderSampleUnit,
  type ResourceChildSample,
  type ResourceSample,
  type ResourceValues,
} from './resources.js';
import type { ResolvedMonitoring } from '../config/monitoring.js';
import type { Provider, ProviderContext, ResolvedService } from '../providers/types.js';

/**
 * The resource sampler.
 *
 * Separate from the status poll on purpose:
 *
 *  - CPU and I/O rates are *differences* between two readings, so sampling needs
 *    memory of the previous reading. `provider.status()` is stateless and is
 *    called from several places (boot sweep, manual refresh, after every action),
 *    which would produce wildly varying time deltas.
 *  - The two have different natural frequencies. Status wants to be fast so the
 *    dashboard feels live; sampling wants to be slow enough that `docker stats`
 *    is not run every few seconds.
 *
 * The loop never overlaps itself, skips services with an action in flight, and
 * builds one `SampleBatch` per tick so all Docker-based providers share a single
 * `docker stats` call.
 */

export interface MonitorTarget {
  service: ResolvedService;
  provider: Provider<unknown>;
  monitoring: ResolvedMonitoring;
  /** True while an action runs for this service. */
  busy: boolean;
  /** Builds the provider context (cwd, env, timeout already applied). */
  context: () => ProviderContext<unknown>;
}

export interface MonitorResult {
  id: string;
  /** Provider type the sample was taken with, so a reload cannot mix them up. */
  type: string;
  /**
   * Fresh sample, or null when the service currently reports nothing. Omitted
   * entirely when the stored sample should be left as it is (a paused service).
   */
  sample?: ResourceSample | null;
  events: AlertEvent[];
  alerts: ResourceAlert[];
}

export interface MonitorHost {
  /** Every service the monitor should consider, rebuilt on each tick. */
  monitorTargets(): MonitorTarget[];
  applyMonitorResult(result: MonitorResult): void;
}

export interface MonitorOptions {
  intervalMs: number;
  /** How many providers may be sampled at once. */
  concurrency?: number;
}

/**
 * An active alert survives this many missed sampling windows before it is
 * cleared as stale. Three ticks tolerates a slow `docker stats` without leaving
 * an alert on screen for a service that stopped reporting minutes ago.
 */
const STALE_TICKS = 3;
const MIN_STALE_MS = 45_000;

export class ResourceMonitor {
  private readonly tracker = new AlertTracker();
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private intervalMs: number;
  private concurrency: number;
  private known = new Set<string>();

  constructor(
    private readonly host: MonitorHost,
    options: MonitorOptions,
    log: Logger = logger,
  ) {
    this.intervalMs = options.intervalMs;
    this.concurrency = options.concurrency ?? 4;
    this.log = log.child({ module: 'monitor' });
  }

  get sampleIntervalMs(): number {
    return this.intervalMs;
  }

  activeAlerts(): ResourceAlert[] {
    return this.tracker.active();
  }

  alertsFor(serviceId: string): ResourceAlert[] {
    return this.tracker.activeFor(serviceId);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    // First tick immediately: rates need a previous reading, so the earlier the
    // first one is taken, the earlier the dashboard shows numbers.
    void this.tick().finally(() => this.schedule());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Applies a new interval (config reload) without restarting the process. */
  reconfigure(intervalMs: number): void {
    this.intervalMs = intervalMs;
  }

  /**
   * Drops per-service state that a config reload removed. `for` and cooldown
   * semantics are time-based, so nothing else needs to be reset on reload.
   */
  forget(serviceIds: Iterable<string>, now = Date.now()): void {
    for (const id of serviceIds) {
      this.counters.delete(id);
      this.known.delete(id);
      const events = this.tracker.forget(id, now);
      if (events.length > 0) {
        this.host.applyMonitorResult({ id, type: 'gone', sample: null, events, alerts: [] });
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => this.log.error({ err: error }, 'sampling tick failed'))
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Previous counter readings, per service. */
  private counters = new Map<string, CounterState>();

  /** One sampling pass. Public for tests; never runs concurrently with itself. */
  async tick(now = Date.now()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const targets = this.host.monitorTargets().filter((target) => target.monitoring.enabled);
      const batch = new SampleBatch(this.log);
      const staleAfterMs = Math.max(this.intervalMs * STALE_TICKS, MIN_STALE_MS);

      // Services that vanished from the config keep no alert state.
      const present = new Set(targets.map((target) => target.service.id));
      for (const id of [...this.known]) {
        if (!present.has(id)) this.forget([id], now);
      }
      this.known = present;

      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (!this.stopped) {
          const target = targets[cursor++];
          if (!target) return;
          await this.sampleTarget(target, batch, now, staleAfterMs);
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(this.concurrency, Math.max(targets.length, 1)) }, worker),
      );
    } finally {
      this.running = false;
    }
  }

  private async sampleTarget(
    target: MonitorTarget,
    batch: SampleBatch,
    now: number,
    staleAfterMs: number,
  ): Promise<void> {
    const id = target.service.id;

    // An action in flight makes every measurement meaningless — a stack being
    // pulled or restarted is not the service under load. Hold state instead.
    if (target.busy) {
      const events = this.tracker.evaluate({
        serviceId: id,
        serviceName: target.service.name,
        values: null,
        monitoring: target.monitoring,
        now,
        paused: true,
        staleAfterMs,
      });
      // Counters from before the action are useless afterwards: a restart resets
      // them, and the gap would otherwise be spread over one huge time delta.
      this.counters.delete(id);
      this.publish(id, undefined, events, target);
      return;
    }

    const context = target.context();
    let raw: ProviderSample | null = null;
    let failed = false;
    try {
      raw = target.provider.sample ? await target.provider.sample(context, batch) : null;
    } catch (error) {
      // Could not measure, as opposed to nothing to measure: `docker stats`
      // timed out, the daemon blinked, /proc vanished mid-read.
      this.log.warn({ err: error, service: id }, 'resource sampling failed');
      failed = true;
    }

    const sample = raw ? this.toSample(id, raw, now) : null;
    const events = this.tracker.evaluate({
      serviceId: id,
      serviceName: target.service.name,
      values: sample,
      monitoring: target.monitoring,
      now,
      staleAfterMs,
    });
    // A service that reports nothing has nothing to show, so its stored sample is
    // cleared. A *failed* sampling attempt leaves the last reading in place — the
    // drawer already shows how old it is, and blanking every Docker service's
    // numbers because one `docker stats` timed out is worse than showing a value
    // from one interval ago. Alerts have their own staleness rule and clear
    // themselves after `staleAfterMs` if the failure persists.
    if (!raw && !failed) this.counters.delete(id);
    this.publish(id, failed ? undefined : sample, events, target);
  }

  /** `undefined` sample means "leave whatever is stored alone" (paused). */
  private publish(
    id: string,
    sample: ResourceSample | null | undefined,
    events: AlertEvent[],
    target: MonitorTarget,
  ): void {
    if (sample === undefined && events.length === 0) return;
    const result: MonitorResult = {
      id,
      type: target.service.type,
      events,
      alerts: this.tracker.activeFor(target.service.id),
    };
    if (sample !== undefined) result.sample = sample;
    this.host.applyMonitorResult(result);
  }

  /** Turns a provider reading plus the previous one into a finished sample. */
  private toSample(id: string, raw: ProviderSample, now: number): ResourceSample | null {
    const previous = this.counters.get(id);
    const dtMs = previous ? now - previous.at : 0;

    const rootValues = valuesFor(raw, previous?.root, dtMs);
    const children: ResourceChildSample[] = [];
    const nextChildren = new Map<string, ReturnType<typeof countersOf>>();

    for (const child of raw.children ?? []) {
      const childValues = valuesFor(child, previous?.children.get(child.id), dtMs);
      const entry: ResourceChildSample = { id: child.id, name: child.name, ...childValues };
      if (child.memoryLimitBytes !== undefined) entry.memoryLimitBytes = child.memoryLimitBytes;
      children.push(entry);
      nextChildren.set(child.id, countersOf(child));
    }

    this.counters.set(id, { at: now, root: countersOf(raw), children: nextChildren });

    // The very first reading after a start has no previous counters, so rates are
    // still unknown. Report it anyway when a gauge (memory) came through —
    // otherwise there is nothing to show and null is the honest answer.
    const sample: ResourceSample = {
      at: new Date(now).toISOString(),
      attribution: raw.attribution,
      ...rootValues,
    };
    if (raw.memoryLimitBytes !== undefined) sample.memoryLimitBytes = raw.memoryLimitBytes;
    if (children.length > 0) sample.children = children;

    if (!hasValues(rootValues) && children.length === 0) return null;
    return sample;
  }
}

function countersOf(unit: ProviderSampleUnit) {
  return unit.counters ?? {};
}

/** Gauges pass through; counters become rates against the previous reading. */
function valuesFor(unit: ProviderSampleUnit, previous: ReturnType<typeof countersOf> | undefined, dtMs: number): ResourceValues {
  const values: ResourceValues = previous ? deriveRates(previous, countersOf(unit), dtMs) : {};
  // A provider-supplied percentage (docker stats) wins over a derived one.
  if (unit.cpuPercent !== undefined) values.cpuPercent = unit.cpuPercent;
  if (unit.memoryBytes !== undefined) values.memoryBytes = unit.memoryBytes;
  return values;
}
