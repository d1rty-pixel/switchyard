import { execCommand, trimForWire, type ExecFn, type ExecRequest } from './exec.js';
import { conflict, notFound, unsupported } from './errors.js';
import { appendHistory, compactHistory } from './history-store.js';
import { logger, type Logger } from './logger.js';
import { alertDigest, format, type AlertEventKind, type AlertSeverity, type ResourceAlert } from './alerts.js';
import { ResourceMonitor, type MonitorHost, type MonitorResult, type MonitorTarget } from './monitor.js';
import {
  bucketSamples,
  metricStats,
  ResourceHistory,
  type HistoryBucket,
  type MetricStats,
} from './resource-history.js';
import {
  buildResourceView,
  sortByMetric,
  sortBySeverity,
  type ServiceResourceView,
} from './resource-view.js';
import { resourceDigest, type ResourceMetric, type ResourceSample } from './resources.js';
import { childRollup, redact, type ServiceDetail, type ServiceSummary } from './views.js';
import type { EventBus } from './events.js';
import type { LoadedConfig } from '../config/load.js';
import { getProvider } from '../providers/index.js';
import type { Provider, ProviderContext, ResolvedService } from '../providers/types.js';
import type {
  ActionDescriptor,
  ActionRecord,
  CommandOutput,
  HistoryEntry,
  HistorySeverity,
  LogsResult,
  ServiceState,
  StatusResult,
} from '../types.js';

/** While an action runs, the card shows this state instead of the stale one. */
const TRANSITIONAL_STATE: Record<string, ServiceState> = {
  start: 'starting',
  up: 'starting',
  restart: 'starting',
  recreate: 'starting',
  reload: 'starting',
  build: 'starting',
  stop: 'stopping',
  down: 'stopping',
  destroy: 'stopping',
};

interface ServiceRecord {
  service: ResolvedService;
  provider: Provider<unknown>;
  actions: ActionDescriptor[];
  status: StatusResult | null;
  statusError: string | null;
  lastCheckedAt: string | null;
  checking: boolean;
  busy: { actionId: string; label: string; startedAt: string } | null;
  history: HistoryEntry[];
  /**
   * Newest action, kept separately because the newest *entry* is now often an
   * alert or a state change, and the card shows the last thing a person did.
   */
  lastAction: ActionRecord | null;
  /** Last resource-sampling failure, held so only the transition is recorded. */
  sampleError: string | null;
  /** Latest resource sample, or null when the service reports none. */
  resources: ResourceSample | null;
  /** Active resource alerts for this service. */
  alerts: ResourceAlert[];
  /** Serialised last emitted summary, used to suppress no-op SSE traffic. */
  lastEmitted: string | null;
}

export interface ActionResponse {
  ok: boolean;
  message: string;
  record: ActionRecord;
  output?: CommandOutput;
  service: ServiceSummary;
}

export class ServiceManager implements MonitorHost {
  private records = new Map<string, ServiceRecord>();
  private config: LoadedConfig;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly log: Logger;
  private readonly monitor: ResourceMonitor;
  private readonly history: ResourceHistory;
  private historyTail: Promise<void> = Promise.resolve();
  private appendsSinceCompaction = 0;

  constructor(
    config: LoadedConfig,
    private readonly bus: EventBus,
    /** JSONL file action history is appended to and replayed from on boot. */
    private readonly historyPath?: string,
  ) {
    this.config = config;
    this.log = logger.child({ module: 'manager' });
    this.history = new ResourceHistory(config.monitoring.historyMs);
    this.applyConfig(config);
    this.monitor = new ResourceMonitor(
      this,
      { intervalMs: config.monitoring.intervalMs, concurrency: config.settings.statusConcurrency },
      this.log,
    );
  }

  // ── configuration ───────────────────────────────────────────────────────────

  private applyConfig(config: LoadedConfig): void {
    const previous = this.records;
    const next = new Map<string, ServiceRecord>();
    const changed: ServiceRecord[] = [];

    for (const service of config.services) {
      const provider = getProvider(service.type);
      if (!provider) continue; // impossible: validated during load
      const existing = previous.get(service.id);
      const sameProvider = existing?.service.type === service.type;
      const record: ServiceRecord = {
        service,
        provider,
        actions: this.buildActions(provider, service),
        status: sameProvider ? existing.status : null,
        statusError: existing?.statusError ?? null,
        lastCheckedAt: existing?.lastCheckedAt ?? null,
        checking: false,
        busy: existing?.busy ?? null,
        history: existing?.history ?? [],
        lastAction: existing?.lastAction ?? null,
        sampleError: existing?.sampleError ?? null,
        // A different provider measures different things, so its samples do not
        // carry over. Counter state is dropped by the monitor for the same reason.
        resources: sameProvider ? existing.resources : null,
        alerts: sameProvider ? existing.alerts : [],
        lastEmitted: null,
      };
      next.set(service.id, record);
      // Retained history measures whatever the old provider measured, with its
      // own attribution — keeping it across a provider swap would mix two
      // different meanings of "CPU for this service" in one series.
      if (existing && !sameProvider) this.history.forget(service.id);
      if (!existing || definitionChanged(existing.service, service)) changed.push(record);
    }

    this.records = next;
    this.config = config;

    // Recorded after the swap so `record()` trims against the new historyLimit.
    // The very first applyConfig runs from the constructor, where every service
    // is "new" and nothing has happened yet — skipped via the empty `previous`.
    if (previous.size > 0) {
      for (const record of changed) {
        const added = !previous.has(record.service.id);
        this.record(record, {
          kind: 'config',
          at: new Date().toISOString(),
          severity: 'info',
          label: added ? 'Service added' : 'Definition changed',
          message: added
            ? `added by a reload of ${config.path}`
            : `definition changed in a reload of ${config.path}`,
        });
      }
      for (const id of previous.keys()) {
        if (this.records.has(id)) continue;
        // No in-memory record survives to hold this, but the log keeps it: the
        // entry reappears if the service is ever configured again.
        this.persist(id, {
          kind: 'config',
          at: new Date().toISOString(),
          severity: 'warning',
          label: 'Service removed',
          message: `removed by a reload of ${config.path}`,
        });
      }
    }
  }

  /** Swap in a freshly loaded config file without restarting the process. */
  async reload(config: LoadedConfig): Promise<void> {
    const busy = [...this.records.values()].filter((record) => record.busy);
    if (busy.length > 0) {
      throw conflict(
        `cannot reload while actions are running: ${busy.map((record) => record.service.id).join(', ')}`,
      );
    }
    const before = new Set(this.records.keys());
    this.applyConfig(config);
    // Alerts and counter state for services the reload removed have no owner
    // left; clearing them also emits the closing `resource:alert` events.
    const removed = [...before].filter((id) => !this.records.has(id));
    this.monitor.forget(removed);
    for (const id of removed) this.history.forget(id);
    this.monitor.reconfigure(config.monitoring.intervalMs);
    this.history.reconfigure(config.monitoring.historyMs);
    this.log.info({ services: config.services.length, path: config.path }, 'configuration reloaded');
    this.bus.emit({ type: 'config:reload', services: config.services.length, at: new Date().toISOString() });
    await this.refreshAll();
  }

  get loadedConfig(): LoadedConfig {
    return this.config;
  }

  /**
   * The authoritative action table for a service: provider capabilities, with
   * confirmation requirements from the service definition merged in.
   */
  private buildActions(provider: Provider<unknown>, service: ResolvedService): ActionDescriptor[] {
    const descriptors = provider.actions({ service, config: service.provider });
    return descriptors.map((descriptor) => ({
      ...descriptor,
      confirm: descriptor.confirm === true || service.confirm.includes(descriptor.id),
    }));
  }

  // ── history ─────────────────────────────────────────────────────────────────

  /** The single write path: in-memory list, its bound, and the persisted log. */
  private record(rec: ServiceRecord, entry: HistoryEntry): void {
    rec.history.push(entry);
    const limit = this.config.settings.historyLimit;
    if (rec.history.length > limit) rec.history.splice(0, rec.history.length - limit);
    if (entry.action) rec.lastAction = entry.action;
    this.persist(rec.service.id, entry);
  }

  /**
   * Appends are chained rather than awaited: an action must not wait on a disk
   * write, but two of them finishing at once must not interleave their lines
   * either. `appendHistory` swallows its own errors, so the chain never rejects.
   */
  private persist(id: string, entry: HistoryEntry): void {
    const path = this.historyPath;
    if (!path) return;
    this.historyTail = this.historyTail.then(async () => {
      await appendHistory(path, id, entry);
      this.appendsSinceCompaction += 1;
      if (this.appendsSinceCompaction < COMPACT_EVERY) return;
      this.appendsSinceCompaction = 0;
      // Inside the chain, so a compaction can never race an append. A process
      // that runs for weeks would otherwise only ever shrink the log at boot.
      await compactHistory(path, {
        historyLimit: this.config.settings.historyLimit,
        retentionMs: this.config.settings.historyRetention,
      });
    });
  }

  /** Awaited on shutdown so a queued append is not lost with the process. */
  async flush(): Promise<void> {
    await this.historyTail;
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  private require(id: string): ServiceRecord {
    const record = this.records.get(id);
    if (!record) throw notFound(`unknown service: ${id}`);
    return record;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  summaries(): ServiceSummary[] {
    return [...this.records.values()]
      .filter((record) => !record.service.hidden)
      .map((record) => this.toSummary(record));
  }

  summary(id: string): ServiceSummary {
    return this.toSummary(this.require(id));
  }

  detail(id: string): ServiceDetail {
    const record = this.require(id);
    const summary = this.toSummary(record);
    return {
      ...summary,
      statusDetail: record.status?.detail,
      childStatuses: record.status?.children ?? [],
      history: [...record.history].reverse(),
      raw: record.status?.raw,
      lastProbe: record.status?.output,
      workdir: record.service.workdir,
      source: record.service.source,
      envKeys: Object.keys(record.service.env),
      providerConfig: redact(record.service.provider),
      monitoringConfig: record.service.monitoring,
    };
  }

  private toSummary(record: ServiceRecord): ServiceSummary {
    const { service, status, busy } = record;
    const transitional = busy ? TRANSITIONAL_STATE[busy.actionId] : undefined;
    const state: ServiceState = transitional ?? status?.state ?? 'unknown';

    const ports = mergePorts(service.ports, status?.ports);
    const urls = mergeUrls(service.urls, status?.urls);

    return {
      id: service.id,
      name: service.name,
      description: service.description,
      icon: service.icon,
      type: service.type,
      providerLabel: record.provider.label,
      group: service.group,
      tags: service.tags,
      order: service.order,

      state,
      statusSummary: status?.summary,
      since: status?.since ?? null,
      lastCheckedAt: record.lastCheckedAt,
      checking: record.checking,
      busy,

      metrics: status?.metrics ?? [],
      warnings: [...(record.statusError ? [record.statusError] : []), ...(status?.warnings ?? [])],
      errors: status?.errors ?? [],
      ports,
      urls,
      actions: record.actions,
      supportsLogs: record.provider.supportsLogs({ service, config: service.provider }),
      children: childRollup(status?.children),
      lastAction: record.lastAction,

      resources: record.resources,
      alerts: record.alerts,
      monitored: service.monitoring.enabled && record.provider.sample !== undefined,
    };
  }

  // ── status probing ──────────────────────────────────────────────────────────

  private context(record: ServiceRecord): ProviderContext<unknown> {
    const service = record.service;
    const exec: ExecFn = (request: ExecRequest) =>
      execCommand({
        ...request,
        cwd: request.cwd ?? service.workdir,
        env: { ...service.env, ...(request.env ?? {}) },
        timeoutMs: request.timeoutMs ?? service.timeout,
      });

    return {
      service,
      config: service.provider,
      exec,
      execRaw: execCommand,
      log: this.log.child({ service: service.id, provider: service.type }),
    };
  }

  async refresh(id: string): Promise<ServiceSummary> {
    const record = this.require(id);
    await this.probe(record);
    return this.toSummary(record);
  }

  private async probe(record: ServiceRecord): Promise<void> {
    if (record.busy) return; // avoid fighting with a running action
    const previousState = record.status?.state ?? null;
    const previousError = record.statusError;
    record.checking = true;
    try {
      const status = await record.provider.status(this.context(record));
      record.status = status;
      record.statusError = null;
    } catch (error) {
      record.status = record.status ?? null;
      record.statusError = `status probe failed: ${(error as Error).message}`;
      this.log.error({ service: record.service.id, err: error }, 'status probe threw');
    } finally {
      record.checking = false;
      record.lastCheckedAt = new Date().toISOString();
    }

    // Transitions only. A service that has been failing for an hour is one
    // entry, not one per poll tick; and the first probe after boot establishes
    // a baseline rather than reporting a change that nobody made.
    const nextState = record.status?.state ?? null;
    if (previousState !== null && nextState !== null && previousState !== nextState) {
      this.record(record, {
        kind: 'state',
        at: record.lastCheckedAt,
        severity: stateSeverity(nextState),
        label: `${previousState} → ${nextState}`,
        message: record.status?.summary ?? `state changed to ${nextState}`,
        state: { from: previousState, to: nextState },
      });
    }
    if (previousError === null && record.statusError !== null) {
      this.record(record, {
        kind: 'probe',
        at: record.lastCheckedAt,
        severity: 'error',
        label: 'Status probe failed',
        message: record.statusError,
      });
    } else if (previousError !== null && record.statusError === null) {
      this.record(record, {
        kind: 'probe',
        at: record.lastCheckedAt,
        severity: 'info',
        label: 'Status probe recovered',
        message: 'the status probe is answering again',
      });
    }

    this.bus.emit({
      type: 'service:checked',
      id: record.service.id,
      state: record.status?.state ?? 'unknown',
      checkedAt: record.lastCheckedAt,
    });
    this.emitIfChanged(record);
  }

  /**
   * Pushes a summary only when something a viewer would notice changed.
   *
   * Resource samples are the reason this needs care: CPU and I/O rates differ on
   * *every* tick, so including them verbatim would emit a full service update
   * per service per sampling interval and re-render numbers that moved by 0.3 %.
   * They enter the fingerprint through a quantized digest instead — a real
   * change in load still pushes an update, noise does not.
   */
  private emitIfChanged(record: ServiceRecord): void {
    const summary = this.toSummary(record);
    const fingerprint = JSON.stringify({
      ...summary,
      lastCheckedAt: null,
      resources: resourceDigest(record.resources),
      alerts: alertDigest(record.alerts),
    });
    if (fingerprint === record.lastEmitted) return;
    record.lastEmitted = fingerprint;
    this.bus.emit({ type: 'service:update', service: summary });
  }

  async refreshAll(): Promise<void> {
    const queue = [...this.records.values()];
    const limit = Math.min(this.config.settings.statusConcurrency, Math.max(queue.length, 1));
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (!this.stopped) {
        const index = cursor++;
        const record = queue[index];
        if (!record) return;
        await this.probe(record);
      }
    };

    await Promise.all(Array.from({ length: limit }, worker));
  }

  // ── resource monitoring ─────────────────────────────────────────────────────

  /** MonitorHost: the services the sampler should look at on this tick. */
  monitorTargets(): MonitorTarget[] {
    return [...this.records.values()]
      .filter((record) => record.provider.sample !== undefined)
      .map((record) => ({
        service: record.service,
        provider: record.provider,
        monitoring: record.service.monitoring,
        busy: record.busy !== null,
        context: () => this.context(record),
      }));
  }

  /** MonitorHost: fold a finished sample and its alert transitions back in. */
  applyMonitorResult(result: MonitorResult): void {
    const record = this.records.get(result.id);
    // A reload may have dropped the service, or swapped its provider, while the
    // sample was in flight — a sample taken through a different provider measures
    // something else and is discarded. The alert events still go out either way,
    // so no alert lingers in the UI for a service that no longer reports it.
    const current = record?.service.type === result.type ? record : undefined;
    if (current) {
      if (result.sample !== undefined) current.resources = result.sample;
      current.alerts = result.alerts;
      // Only real samples enter the history: `undefined` means "hold what is
      // stored" (an action is running) and `null` means there was nothing to
      // measure. Neither is a reading, and recording either would make an idle
      // or restarting service look like a measured one.
      if (result.sample) {
        this.history.append(result.id, Date.parse(result.sample.at), result.sample);
      }
    }
    // No record, or one whose provider changed under an in-flight sample: the
    // series that history belongs to no longer exists.
    if (!current) this.history.forget(result.id);

    for (const event of result.events) {
      this.log[event.alert.severity === 'critical' ? 'warn' : 'info'](
        {
          service: event.alert.serviceId,
          metric: event.alert.metric,
          severity: event.alert.severity,
          value: event.alert.value,
          threshold: event.alert.threshold,
        },
        `resource alert ${event.kind}`,
      );
      // Recorded on the surviving record only — a service dropped by a reload
      // has nowhere to put it, and its closing events are pure cleanup.
      if (current) {
        const { alert } = event;
        this.record(current, {
          kind: 'alert',
          at: alert.updatedAt,
          severity: alertSeverity(event.kind, alert.severity),
          label: `${alert.label} ${ALERT_EVENT_LABEL[event.kind]}`,
          message: `${format(alert.value, alert.unit)} against a ${alert.severity} threshold of ${format(alert.threshold, alert.unit)} — ${event.reason}`,
          alert: {
            event: event.kind,
            metric: alert.metric,
            severity: alert.severity,
            value: alert.value,
            threshold: alert.threshold,
            unit: alert.unit,
          },
        });
      }
      this.bus.emit({
        type: 'resource:alert',
        event: event.kind,
        alert: event.alert,
        notify: event.notify,
        reason: event.reason,
      });
    }

    // Same transition-only rule as the status probe: one entry when sampling
    // starts failing, one when it works again, nothing in between.
    if (current) {
      const error = result.error ?? null;
      if (error !== null && current.sampleError === null) {
        this.record(current, {
          kind: 'probe',
          at: new Date().toISOString(),
          severity: 'warning',
          label: 'Resource sampling failed',
          message: error,
        });
      } else if (error === null && current.sampleError !== null && result.sample !== undefined) {
        this.record(current, {
          kind: 'probe',
          at: new Date().toISOString(),
          severity: 'info',
          label: 'Resource sampling recovered',
          message: 'measurements are arriving again',
        });
      }
      if (result.sample !== undefined || error !== null) current.sampleError = error;
    }

    if (record) this.emitIfChanged(record);
  }

  /** Every active resource alert, most severe first. */
  activeAlerts(): ResourceAlert[] {
    return this.monitor.activeAlerts();
  }

  get monitorIntervalMs(): number {
    return this.monitor.sampleIntervalMs;
  }

  get historyRetentionMs(): number {
    return this.history.retention;
  }

  /**
   * Measurement, unit, threshold and threshold state per service, in one shot.
   *
   * Deliberately one call for all services: the questions this answers ("what is
   * hottest right now", "is anything over its limits") are comparisons, and
   * answering them per service would need the whole set anyway.
   */
  resourceViews(options: { sort?: ResourceMetric; now?: number } = {}): ServiceResourceView[] {
    const now = options.now ?? Date.now();
    const views = [...this.records.values()]
      .filter((record) => !record.service.hidden)
      .map((record) => this.toResourceView(record, now));
    return options.sort ? sortByMetric(views, options.sort) : sortBySeverity(views);
  }

  resourceView(id: string, now = Date.now()): ServiceResourceView {
    return this.toResourceView(this.require(id), now);
  }

  private toResourceView(record: ServiceRecord, now: number): ServiceResourceView {
    const { service } = record;
    return buildResourceView({
      id: service.id,
      name: service.name,
      type: service.type,
      providerLabel: record.provider.label,
      group: service.group,
      state: this.toSummary(record).state,
      monitored: service.monitoring.enabled && record.provider.sample !== undefined,
      busy: record.busy !== null,
      monitoring: service.monitoring,
      sample: record.resources,
      alerts: record.alerts,
      pending: this.monitor.pendingFor(service.id),
      historySamples: this.history.size(service.id),
      now,
    });
  }

  /**
   * Trend data for one service: per-metric statistics plus a bucketed series.
   *
   * The statistics are computed here rather than by the caller because deciding
   * what "above the warning threshold" means requires the resolved thresholds,
   * which live in this process.
   */
  resourceHistory(
    id: string,
    options: { windowMs: number; buckets: number; now?: number },
  ): {
    id: string;
    windowMs: number;
    from: string;
    to: string;
    /** Retention actually configured — a window longer than this cannot be met. */
    retentionMs: number;
    samples: number;
    /** Span the retained samples really cover, which may be shorter. */
    spanMs: number;
    intervalMs: number;
    stats: MetricStats[];
    buckets: HistoryBucket[];
  } {
    const record = this.require(id);
    const now = options.now ?? Date.now();
    const from = now - options.windowMs;
    const samples = this.history.samples(id, options.windowMs, now);
    const first = samples[0];
    const last = samples[samples.length - 1];

    return {
      id,
      windowMs: options.windowMs,
      from: new Date(from).toISOString(),
      to: new Date(now).toISOString(),
      retentionMs: this.history.retention,
      samples: samples.length,
      spanMs: first && last ? last.at - first.at : 0,
      intervalMs: this.monitor.sampleIntervalMs,
      stats: metricStats(samples, record.service.monitoring.thresholds),
      buckets: bucketSamples(samples, options.buckets, from, now),
    };
  }

  // ── actions ─────────────────────────────────────────────────────────────────

  /**
   * Runs a named action. `actionId` is resolved against the provider's action
   * table; nothing from the request reaches an argv array.
   */
  async runAction(id: string, actionId: string): Promise<ActionResponse> {
    const record = this.require(id);
    const descriptor = record.actions.find((action) => action.id === actionId);
    if (!descriptor) {
      this.record(record, {
        kind: 'rejected',
        at: new Date().toISOString(),
        severity: 'warning',
        label: 'Action rejected',
        message: `unknown action "${actionId}"`,
      });
      throw notFound(`unknown action "${actionId}" for service "${id}"`, {
        available: record.actions.map((action) => action.id),
      });
    }

    if (record.busy) {
      this.record(record, {
        kind: 'rejected',
        at: new Date().toISOString(),
        severity: 'warning',
        label: `${descriptor.label} rejected`,
        message: `"${record.busy.label}" was already running`,
      });
      throw conflict(`"${record.busy.label}" is already running for ${id}`, { busy: record.busy });
    }

    const startedAt = new Date();
    record.busy = { actionId: descriptor.id, label: descriptor.label, startedAt: startedAt.toISOString() };
    this.bus.emit({
      type: 'action:start',
      id,
      actionId: descriptor.id,
      label: descriptor.label,
      startedAt: record.busy.startedAt,
    });
    this.emitIfChanged(record);

    const log = this.log.child({ service: id, action: descriptor.id });
    log.info('action started');

    let outcome;
    try {
      outcome = await record.provider.runAction(this.context(record), descriptor);
    } catch (error) {
      log.error({ err: error }, 'action threw');
      outcome = { ok: false, message: `${descriptor.label} failed: ${(error as Error).message}` };
    }

    const finishedAt = new Date();
    const actionRecord: ActionRecord = {
      actionId: descriptor.id,
      label: descriptor.label,
      ok: outcome.ok,
      message: outcome.message,
      startedAt: startedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode: outcome.output?.exitCode ?? null,
      excerpt: outcome.output?.stderr ? trimForWire(outcome.output.stderr).split('\n').slice(0, 6).join('\n') : undefined,
    };

    record.busy = null;
    this.record(record, {
      kind: 'action',
      at: actionRecord.startedAt,
      severity: outcome.ok ? 'info' : 'error',
      label: descriptor.label,
      message: outcome.message,
      action: actionRecord,
    });

    log[outcome.ok ? 'info' : 'warn'](
      { ok: outcome.ok, durationMs: actionRecord.durationMs, exitCode: actionRecord.exitCode },
      'action finished',
    );

    this.bus.emit({ type: 'action:end', id, actionId: descriptor.id, record: actionRecord });

    // Reflect the new reality immediately instead of waiting for the poll tick.
    // Short settle delay first: signals like `nginx -s quit` return before the
    // process is actually gone, and probing too early reports the old state.
    await delay(POST_ACTION_SETTLE_MS);
    await this.probe(record);
    this.emitIfChanged(record);

    return {
      ok: outcome.ok,
      message: outcome.message,
      record: actionRecord,
      output: outcome.output,
      service: this.toSummary(record),
    };
  }

  // ── logs ────────────────────────────────────────────────────────────────────

  async logs(id: string, tail?: number, containers?: string[]): Promise<LogsResult> {
    const record = this.require(id);
    const context = this.context(record);
    if (!record.provider.supportsLogs({ service: record.service, config: record.service.provider }) || !record.provider.logs) {
      throw unsupported(`service "${id}" does not expose logs`);
    }
    const limit = clamp(tail ?? this.config.settings.logsTail, 10, 5_000);
    // Only pass through container names this service actually has, so a stale
    // or tampered filter can't reach the provider's argv as free-form input.
    const known = new Set((record.status?.children ?? []).map((child) => child.service ?? child.name));
    const filtered = containers?.filter((name) => known.has(name));
    return await record.provider.logs(context, { tail: limit, containers: filtered?.length ? filtered : undefined });
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.restoreHistory();
    await this.refreshAll();
    this.bus.emit({ type: 'ready', at: new Date().toISOString() });
    this.schedule();
    // Started unconditionally: `monitoring.enabled: false` is already reflected in
    // every service's resolved monitoring, so the sampler simply finds no targets.
    // Gating the loop itself here instead would leave it dead after a reload that
    // switches monitoring back on.
    this.monitor.start();
  }

  /**
   * Replays persisted history into the in-memory records once, at boot, and
   * purges the log in the same pass — it is fully parsed here either way.
   */
  private async restoreHistory(): Promise<void> {
    const path = this.historyPath;
    if (!path) return;
    // Through the same chain as every append: the HTTP server is already
    // listening by the time this runs, so an action could otherwise land in the
    // file between the compaction reading it and renaming the rewrite over it.
    const restore = this.historyTail.then(() =>
      compactHistory(path, {
        historyLimit: this.config.settings.historyLimit,
        retentionMs: this.config.settings.historyRetention,
      }),
    );
    this.historyTail = restore.then(() => undefined);
    const byService = await restore;
    for (const [id, history] of byService) {
      const record = this.records.get(id);
      if (!record) continue;
      record.history = history;
      record.lastAction = [...history].reverse().find((entry) => entry.action)?.action ?? null;
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.refreshAll()
        .catch((error) => this.log.error({ err: error }, 'poll cycle failed'))
        .finally(() => this.schedule());
    }, this.config.settings.statusIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.monitor.stop();
  }
}

/** Grace period between finishing an action and re-probing status. */
const POST_ACTION_SETTLE_MS = 500;

/** Appends between two runtime compactions of the persisted log. */
const COMPACT_EVERY = 500;

const ALERT_EVENT_LABEL: Record<AlertEventKind, string> = {
  activated: 'alert',
  escalated: 'escalated',
  deescalated: 'de-escalated',
  cleared: 'cleared',
};

function alertSeverity(kind: AlertEventKind, severity: AlertSeverity): HistorySeverity {
  if (kind === 'cleared' || kind === 'deescalated') return 'info';
  return severity === 'critical' ? 'error' : 'warning';
}

function stateSeverity(state: ServiceState): HistorySeverity {
  if (state === 'failed') return 'error';
  if (state === 'degraded' || state === 'unknown') return 'warning';
  return 'info';
}

/**
 * Whether a reload actually changed a service, rather than merely re-reading it.
 * Compared as serialised data — `ResolvedService` is plain config, so a
 * structural comparison is both correct and cheap enough at reload frequency.
 */
function definitionChanged(previous: ResolvedService, next: ResolvedService): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Static config ports first, runtime-discovered ones appended if new. */
function mergePorts(
  configured: ServiceSummary['ports'],
  discovered?: ServiceSummary['ports'],
): ServiceSummary['ports'] {
  if (!discovered || discovered.length === 0) return configured;
  const merged = [...configured];
  for (const port of discovered) {
    const key = port.hostPort ?? port.port;
    const exists = merged.some((existing) => (existing.hostPort ?? existing.port) === key && existing.protocol === port.protocol);
    if (!exists) merged.push(port);
  }
  return merged;
}

function mergeUrls(configured: ServiceSummary['urls'], discovered?: ServiceSummary['urls']): ServiceSummary['urls'] {
  if (!discovered || discovered.length === 0) return configured;
  const merged = [...configured];
  for (const url of discovered) {
    if (!merged.some((existing) => existing.url === url.url)) merged.push(url);
  }
  return merged;
}
