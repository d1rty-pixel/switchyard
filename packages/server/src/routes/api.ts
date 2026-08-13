import { cpus, hostname, totalmem } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../core/errors.js';
import { diffConfig } from '../config/diff.js';
import { loadConfig } from '../config/load.js';
import { idSchema, actionIdSchema } from '../config/schema.js';
import { MONITORING_DEFAULTS } from '../config/monitoring.js';
import { RESOURCE_METRICS, RESOURCE_METRIC_INFO } from '../core/resources.js';
import { listProviders } from '../providers/index.js';
import { durationSchema } from '../config/units.js';
import type { ServiceManager } from '../core/manager.js';
import type { EventBus } from '../core/events.js';

const paramsSchema = z.object({ id: idSchema });
const actionParamsSchema = z.object({ id: idSchema, action: actionIdSchema });
const logsQuerySchema = z.object({
  tail: z.coerce.number().int().min(10).max(5_000).optional(),
  // Comma-separated container/service names to restrict logs to; manager.logs()
  // re-validates each against the service's actual children before use.
  containers: z
    .string()
    .optional()
    .transform((value) => value?.split(',').map((entry) => entry.trim()).filter(Boolean)),
});

const resourcesQuerySchema = z.object({
  service: idSchema.optional(),
  /** Order the list by one metric, highest first. */
  sort: z.enum(RESOURCE_METRICS).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** Bounds the returned series regardless of how long a window was asked for. */
const MAX_BUCKETS = 120;
const DEFAULT_BUCKETS = 30;
const DEFAULT_HISTORY_WINDOW_MS = 900_000;

const historyQuerySchema = z.object({
  /** Duration string, e.g. `15m`. Clamped to the configured retention. */
  window: durationSchema.optional(),
  buckets: z.coerce.number().int().min(1).max(MAX_BUCKETS).optional(),
});

/** Static description of the machine, so absolute numbers can be interpreted. */
function hostInfo(): { hostname: string; cpuCount: number; totalMemoryBytes: number } {
  return { hostname: hostname(), cpuCount: cpus().length, totalMemoryBytes: totalmem() };
}

/** The metric vocabulary: what each metric is called and what unit it is in. */
function metricCatalog(): { metric: string; label: string; unit: string }[] {
  return RESOURCE_METRICS.map((metric) => ({
    metric,
    label: RESOURCE_METRIC_INFO[metric].label,
    unit: RESOURCE_METRIC_INFO[metric].unit,
  }));
}

export interface ApiDeps {
  manager: ServiceManager;
  bus: EventBus;
  version: string;
  configPathOverride?: string;
  startedAt: number;
}

/**
 * The HTTP surface.
 *
 * Validation rule that matters: request parameters are only ever used as *keys*
 * — a service id looked up in the config map, an action id looked up in the
 * provider's action table. Nothing here can influence a command line.
 */
export async function registerApi(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { manager, bus } = deps;

  app.get('/api/health', async () => ({
    ok: true,
    version: deps.version,
    uptimeMs: Date.now() - deps.startedAt,
    services: manager.summaries().length,
    subscribers: bus.subscriberCount,
  }));

  app.get('/api/meta', async () => {
    const config = manager.loadedConfig;
    return {
      app: { name: 'Switchyard', version: deps.version },
      configPath: config.path,
      serviceDirs: config.serviceDirs,
      configWarnings: config.warnings,
      /** Definitions switched off with `enabled: false`. */
      disabledServices: config.disabled,
      groups: config.groups,
      providers: listProviders().map((provider) => ({
        type: provider.type,
        label: provider.label,
        description: provider.description,
      })),
      settings: {
        statusIntervalMs: config.settings.statusIntervalMs,
        logsTail: config.settings.logsTail,
        monitoring: {
          enabled: config.monitoring.enabled,
          intervalMs: manager.monitorIntervalMs,
        },
      },
      /**
       * Resource thresholds are absolute per-service values, so `150 %` means
       * nothing without knowing how many cores the host has. Static, and cheap
       * to read, so it travels with the rest of the metadata.
       */
      host: hostInfo(),
      monitoring: {
        enabled: config.monitoring.enabled,
        intervalMs: manager.monitorIntervalMs,
        historyMs: manager.historyRetentionMs,
        /** Vocabulary for every resource metric: label and unit. */
        metrics: metricCatalog(),
        defaults: {
          forMs: config.monitoring.forMs,
          clearBelow: config.monitoring.clearBelow,
          cooldownMs: config.monitoring.cooldownMs,
          historyMs: MONITORING_DEFAULTS.historyMs,
        },
        /** Global thresholds every service inherits unless it overrides them. */
        thresholds: config.monitoring.thresholds,
      },
    };
  });

  app.get('/api/services', async () => ({ services: manager.summaries() }));

  /** Active resource alerts across all services, most severe first. */
  app.get('/api/alerts', async () => ({ alerts: manager.activeAlerts() }));

  /**
   * Per-service resource measurements with their units, thresholds and threshold
   * state. Separate from `/api/services` because that payload carries actions,
   * ports, probe output and history — everything except what a "who is eating the
   * machine?" question needs.
   */
  app.get('/api/resources', async (request) => {
    const { service, sort, limit } = parse(resourcesQuerySchema, request.query ?? {});
    const now = Date.now();

    const views = service ? [manager.resourceView(service, now)] : manager.resourceViews({ sort, now });
    const limited = limit !== undefined ? views.slice(0, limit) : views;

    return {
      at: new Date(now).toISOString(),
      host: hostInfo(),
      monitoring: {
        enabled: manager.loadedConfig.monitoring.enabled,
        intervalMs: manager.monitorIntervalMs,
        historyMs: manager.historyRetentionMs,
        metrics: metricCatalog(),
      },
      /** Number of services dropped by `limit`, so a truncated list says so. */
      truncated: views.length - limited.length,
      services: limited,
    };
  });

  /**
   * Bounded trend view for one service: per-metric statistics plus a fixed-size
   * bucketed series. Answers "sustained or a spike?", which the latest sample
   * cannot.
   */
  app.get('/api/services/:id/resources/history', async (request) => {
    const { id } = parse(paramsSchema, request.params);
    const { window, buckets } = parse(historyQuerySchema, request.query ?? {});
    // A window longer than retention would silently promise data that was never
    // kept; the response reports both so the caller can see the difference.
    const windowMs = Math.min(window ?? DEFAULT_HISTORY_WINDOW_MS, manager.historyRetentionMs);
    return manager.resourceHistory(id, { windowMs, buckets: buckets ?? DEFAULT_BUCKETS });
  });

  app.get('/api/services/:id', async (request) => {
    const { id } = parse(paramsSchema, request.params);
    return manager.detail(id);
  });

  app.post('/api/services/:id/refresh', async (request) => {
    const { id } = parse(paramsSchema, request.params);
    return { service: await manager.refresh(id) };
  });

  app.post('/api/services/:id/actions/:action', async (request, reply) => {
    const { id, action } = parse(actionParamsSchema, request.params);
    const result = await manager.runAction(id, action);
    // A failed command is a successful API call that reports failure; the client
    // needs the output either way. Only protocol-level problems get 4xx/5xx.
    reply.code(200);
    return result;
  });

  app.get('/api/services/:id/logs', async (request) => {
    const { id } = parse(paramsSchema, request.params);
    const { tail, containers } = parse(logsQuerySchema, request.query ?? {});
    const logs = await manager.logs(id, tail, containers);
    return { id, ...logs, fetchedAt: new Date().toISOString() };
  });

  app.post('/api/reload', async () => {
    const config = await loadConfig(deps.configPathOverride);
    await manager.reload(config);
    return { ok: true, path: config.path, services: config.services.length, warnings: config.warnings };
  });

  // Parses the config files on disk and reports what would change, without
  // swapping anything in — lets the UI show a diff before the user commits.
  app.get('/api/reload/preview', async () => {
    const next = await loadConfig(deps.configPathOverride);
    const diff = diffConfig(manager.loadedConfig, next);
    return { path: next.path, services: next.services.length, warnings: next.warnings, diff };
  });

  registerEventStream(app, deps);
}

/** Server-sent events: one long-lived response per dashboard tab. */
function registerEventStream(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/api/events', (request, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('snapshot', { services: deps.manager.summaries(), at: new Date().toISOString() });

    const unsubscribe = deps.bus.subscribe((event) => {
      try {
        send(event.type, event);
      } catch {
        unsubscribe();
      }
    });

    // Comment frames keep proxies and the browser from closing an idle stream.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 15_000);
    heartbeat.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; '),
    );
  }
  return result.data;
}
