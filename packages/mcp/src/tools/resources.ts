import { z } from 'zod';
import {
  formatAge,
  formatAlert,
  formatBytes,
  formatDuration,
  formatFraction,
  formatMetric,
  formatValue,
  lines,
  round,
  samplingNote,
  stateMarker,
} from '../format.js';
import { guard, serviceIdParam, textResult, RESOURCE_METRIC_PARAM, type ToolResult } from './shared.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SwitchyardClient } from '../client.js';
import type {
  ChildResourceView,
  HistoryResponse,
  ResourceAlert,
  ResourcesResponse,
  ServiceResourceView,
} from '../wire.js';

/**
 * Resource consumption: the current picture, its trend, and active alerts.
 *
 * `get_resource_usage` is deliberately one call for the whole machine. "Which
 * service is eating the CPU?" is a comparison, and the alternative — a call per
 * service, then a second call each for the thresholds — is both slower and easier
 * to get wrong. Measurements come with their unit, their threshold and the age of
 * the sample they came from, so no number has to be interpreted on faith.
 */

export function registerResourceTools(server: McpServer, client: SwitchyardClient): void {
  server.registerTool(
    'get_resource_usage',
    {
      title: 'Resource usage per service',
      description:
        'CPU, memory, disk and network consumption per service, with units, sample age, ' +
        'attribution, configured warning/critical thresholds, percentage of threshold, and ' +
        'threshold state including breaches that have started but not yet alerted. Answers ' +
        '"which services consume the most CPU", "how much memory does X use" and "is anything ' +
        'over its limits" in one call. Metrics a provider cannot measure are reported as ' +
        'unmeasured, never as zero.',
      inputSchema: {
        service: serviceIdParam.optional().describe('Restrict to one service; omit for all'),
        sort: z
          .enum(RESOURCE_METRIC_PARAM)
          .optional()
          .describe('Order by this metric, highest first. Default: worst threshold state first'),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Keep only the first N services after sorting'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      guard(async () => {
        const query: { service?: string; sort?: string; limit?: number } = {};
        if (args.service !== undefined) query.service = args.service;
        if (args.sort !== undefined) query.sort = args.sort;
        if (args.limit !== undefined) query.limit = args.limit;
        const payload = await client.resources(query);
        return usageResult(payload, args.sort);
      }),
  );

  server.registerTool(
    'get_resource_history',
    {
      title: 'Resource usage trend for one service',
      description:
        'Statistics and a bucketed series over the retained sample history for one service: ' +
        'min, max, average, p95, latest, sample count, the time span actually covered, and the ' +
        'share of samples above the warning and critical thresholds. This is what separates a ' +
        'transient spike from sustained load. History is kept in memory only and starts fresh ' +
        'after a Switchyard restart.',
      inputSchema: {
        service: serviceIdParam,
        window: z
          .string()
          .regex(
            /^\d+(?:ms|s|m|h)(?:\d+(?:ms|s|m|h))*$/,
            'duration with a unit, e.g. 5m, 30m, 2h, 1m30s — a bare number is not accepted',
          )
          .optional()
          .describe('How far back to look (default 15m). Clamped to the configured retention'),
        metrics: z
          .array(z.enum(RESOURCE_METRIC_PARAM))
          .optional()
          .describe('Restrict the report to these metrics'),
        buckets: z.coerce
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe('Number of time buckets in the series (default 30, hard maximum 120)'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      guard(async () => {
        const query: { window?: string; buckets?: number } = {};
        if (args.window !== undefined) query.window = args.window;
        if (args.buckets !== undefined) query.buckets = args.buckets;
        const payload = await client.history(args.service, query);
        return historyResult(payload, args.metrics);
      }),
  );

  server.registerTool(
    'get_alerts',
    {
      title: 'Active resource alerts',
      description:
        'Every resource alert Switchyard currently holds active, worst first, with the measured ' +
        'value, the threshold it crossed, when the breach began and how long the alert has been ' +
        'active. Use this to explain why a service is alerting.',
      inputSchema: {
        service: serviceIdParam.optional().describe('Restrict to one service'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      guard(async () => {
        const { alerts } = await client.alerts();
        const filtered = args.service ? alerts.filter((alert) => alert.serviceId === args.service) : alerts;
        return alertsResult(filtered, args.service);
      }),
  );
}

function usageResult(payload: ResourcesResponse, sort?: string): ToolResult {
  const { host, monitoring, services } = payload;
  const head = [
    `Resource usage at ${payload.at} — sampled every ${formatDuration(monitoring.intervalMs)}, ` +
      `history ${formatDuration(monitoring.historyMs)}`,
    `Host ${host.hostname}: ${host.cpuCount} CPU threads (100% = one core, ${host.cpuCount * 100}% = all of them), ` +
      `${formatBytes(host.totalMemoryBytes)} RAM`,
    monitoring.enabled ? undefined : 'Monitoring is switched off globally — no samples are being taken.',
    sort ? `Ordered by ${sort}, highest first.` : 'Ordered by worst threshold state first.',
    payload.truncated > 0 ? `${payload.truncated} further service(s) omitted by limit.` : undefined,
  ];

  const blocks = services.map((view) => serviceBlock(view));

  return textResult(
    lines(
      ...head,
      '',
      blocks.length > 0 ? blocks.join('\n') : 'No services to report.',
      '',
      'Thresholds are absolute per-service values, not shares of the host.',
    ),
    payload as unknown as Record<string, unknown>,
  );
}

function serviceBlock(view: ServiceResourceView): string {
  const measured = view.metrics.filter((metric) => metric.value !== undefined);
  // The age comes from the server's own clock, which took the sample; deriving it
  // here from the timestamp would drift with any difference between the two.
  const head =
    `${stateMarker(view.worst)}  ${view.id} (${view.type}, ${view.state})` +
    (view.sampledAt ? ` sampled ${formatAge(view.ageMs)}` : '');

  const body: string[] = [];
  if (measured.length > 0) {
    body.push(`      ${measured.map(formatMetric).join('  ·  ')}`);
  }

  const memory = view.memory;
  if (memory?.limitBytes !== undefined && memory.percentOfLimit !== undefined) {
    body.push(
      `      memory limit ${formatBytes(memory.limitBytes)} — using ${round(memory.percentOfLimit)}% of it`,
    );
  }

  const note = samplingNote(view);
  if (note) body.push(`      ${note}`);

  if (view.attribution) body.push(`      attribution: ${view.attribution}`);

  // Thresholds configured on metrics that cannot be measured here would never
  // fire; saying so is more useful than leaving the caller to notice.
  const inert = view.metrics.filter((metric) => metric.state === 'unmeasured');
  if (inert.length > 0) {
    body.push(`      inert thresholds: ${inert.map(formatMetric).join('  ·  ')}`);
  }
  if (view.unmeasured.length > 0) {
    body.push(`      no measurement for: ${view.unmeasured.join(', ')}`);
  }

  if (view.children && view.children.length > 0) {
    body.push(`      containers: ${view.children.map(childLine).join('  ·  ')}`);
  }

  for (const alert of view.alerts) {
    body.push(`      ALERT ${formatAlert(alert)}`);
  }

  if (view.historySamples > 0) {
    body.push(`      ${view.historySamples} history sample(s) retained — get_resource_history for the trend`);
  }

  return lines(head, ...body);
}

function childLine(child: ChildResourceView): string {
  const parts: string[] = [child.name];
  if (child.cpuPercent !== undefined) parts.push(formatValue(child.cpuPercent, 'percent'));
  if (child.memoryBytes !== undefined) {
    const limit =
      child.percentOfMemoryLimit !== undefined ? ` (${round(child.percentOfMemoryLimit)}% of limit)` : '';
    parts.push(`${formatBytes(child.memoryBytes)}${limit}`);
  }
  return parts.join(' ');
}

function historyResult(payload: HistoryResponse, metrics?: string[]): ToolResult {
  const wanted = metrics && metrics.length > 0 ? new Set(metrics) : undefined;
  const stats = wanted ? payload.stats.filter((entry) => wanted.has(entry.metric)) : payload.stats;

  if (payload.samples === 0) {
    return textResult(
      lines(
        `${payload.id} — no resource samples retained in the last ${formatDuration(payload.windowMs)}.`,
        `Retention is ${formatDuration(payload.retentionMs)} and sampling runs every ${formatDuration(payload.intervalMs)};` +
          ' a stopped service, a provider that cannot sample, or a recent Switchyard restart all look like this.',
      ),
      payload as unknown as Record<string, unknown>,
    );
  }

  const statLines = stats.map((entry) => {
    const shares = [
      entry.warning !== undefined && entry.fractionAboveWarning !== undefined
        ? `${formatFraction(entry.fractionAboveWarning)} of samples ≥ warning ${formatValue(entry.warning, entry.unit)}`
        : undefined,
      entry.critical !== undefined && entry.fractionAboveCritical !== undefined
        ? `${formatFraction(entry.fractionAboveCritical)} ≥ critical ${formatValue(entry.critical, entry.unit)}`
        : undefined,
    ].filter(Boolean);
    return lines(
      `  ${entry.metric} (${entry.unit}, ${entry.samples} samples over ${formatDuration(entry.spanMs)})`,
      `      min ${formatValue(entry.min, entry.unit)} · avg ${formatValue(entry.average, entry.unit)} · ` +
        `p95 ${formatValue(entry.p95, entry.unit)} · max ${formatValue(entry.max, entry.unit)} · ` +
        `latest ${formatValue(entry.latest, entry.unit)}`,
      shares.length > 0 ? `      ${shares.join(' · ')}` : '      no thresholds configured for this metric',
    );
  });

  const bucketLines = seriesLines(payload, wanted);

  return textResult(
    lines(
      `${payload.id} — resource history over ${formatDuration(payload.windowMs)} ` +
        `(${payload.from} → ${payload.to})`,
      `${payload.samples} sample(s) covering ${formatDuration(payload.spanMs)}; ` +
        `retention ${formatDuration(payload.retentionMs)}, sampling interval ${formatDuration(payload.intervalMs)}`,
      payload.spanMs < payload.windowMs * 0.5
        ? 'The retained span is well short of the requested window — treat trends as provisional.'
        : undefined,
      '',
      statLines.length > 0 ? statLines.join('\n') : '  no metrics matched',
      '',
      bucketLines,
    ),
    payload as unknown as Record<string, unknown>,
  );
}

/** One line of bucket averages per metric, plus the peak, so shape is visible. */
function seriesLines(payload: HistoryResponse, wanted?: Set<string>): string {
  if (payload.buckets.length === 0) return '';
  const first = payload.buckets[0];
  const width = first ? Date.parse(first.endAt) - Date.parse(first.at) : 0;
  const present = payload.stats
    .map((entry) => entry.metric)
    .filter((metric) => !wanted || wanted.has(metric));

  const rows = present.map((metric) => {
    const values = payload.buckets.map((bucket) => {
      const entry = bucket.values[metric];
      return entry === undefined ? '–' : String(round(entry.average));
    });
    const peaks = payload.buckets
      .map((bucket) => bucket.values[metric]?.max)
      .filter((value): value is number => value !== undefined);
    const peak = peaks.length > 0 ? Math.max(...peaks) : undefined;
    const unit = payload.stats.find((entry) => entry.metric === metric)?.unit ?? 'percent';
    return `  ${metric} avg per bucket: ${values.join(' ')}${peak === undefined ? '' : `   (peak ${formatValue(peak, unit)})`}`;
  });

  return lines(
    `Series — ${payload.buckets.length} bucket(s) of ${formatDuration(width)}, oldest first, "–" where nothing was sampled:`,
    ...rows,
  );
}

function alertsResult(alerts: ResourceAlert[], service?: string): ToolResult {
  if (alerts.length === 0) {
    return textResult(
      service
        ? `No active resource alerts for ${service}.`
        : 'No active resource alerts. Every sampled service is below its configured thresholds.',
      { alerts: [] },
    );
  }

  const now = Date.now();
  return textResult(
    lines(
      `${alerts.length} active resource alert(s), worst first:`,
      '',
      ...alerts.map((alert) => `  ${formatAlert(alert, now)}`),
      '',
      'Switchyard reports; it never throttles or restarts anything on its own.',
    ),
    { alerts: alerts as unknown as Record<string, unknown>[] },
  );
}
