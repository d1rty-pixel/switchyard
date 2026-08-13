import { z } from 'zod';
import { ageOf, formatDuration, formatMetric, lines, table } from '../format.js';
import { guard, serviceIdParam, textResult, type ToolResult } from './shared.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SwitchyardClient } from '../client.js';
import type { ActionDescriptor, ServiceDetail, ServiceState, ServiceSummary } from '../wire.js';

/**
 * The service roster and one service in full.
 *
 * `list_services` projects the summary down hard. `/api/services` carries every
 * action descriptor, every port, every status metric and the last probe's output
 * for every service — around 20 kB for ten services, most of it irrelevant to
 * "what is running?". What survives here is what picks the next call: id, state,
 * whether it can be sampled or logged, and which action ids exist.
 */

export function registerServiceTools(server: McpServer, client: SwitchyardClient): void {
  server.registerTool(
    'list_services',
    {
      title: 'List Switchyard services',
      description:
        'Compact roster of every service Switchyard manages: id, state, provider, group, ' +
        'alert count, and the action ids that can be run. Start here, then use get_service, ' +
        'get_resource_usage or get_logs for detail. Optional filters narrow by group, state or tag.',
      inputSchema: {
        group: z.string().optional().describe('Only services in this group id'),
        state: z
          .enum(['running', 'stopped', 'starting', 'stopping', 'degraded', 'failed', 'unknown'])
          .optional()
          .describe('Only services currently in this state'),
        tag: z.string().optional().describe('Only services carrying this tag'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      guard(async () => {
        const { services } = await client.services();
        const filtered = services.filter(
          (service) =>
            (args.group === undefined || service.group === args.group) &&
            (args.state === undefined || service.state === args.state) &&
            (args.tag === undefined || service.tags.includes(args.tag)),
        );
        return listResult(filtered, services.length, args);
      }),
  );

  server.registerTool(
    'get_service',
    {
      title: 'Inspect one Switchyard service',
      description:
        'Everything Switchyard knows about one service: status detail, provider metrics, ' +
        'containers or child units, endpoints, resource sample with its thresholds, active ' +
        'alerts, recent action history and the config file it came from.',
      inputSchema: { service: serviceIdParam },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (args) =>
      guard(async () => {
        const detail = await client.service(args.service);
        return detailResult(detail);
      }),
  );
}

function listResult(
  services: ServiceSummary[],
  total: number,
  filters: { group?: string; state?: string; tag?: string },
): ToolResult {
  if (services.length === 0) {
    const active = describeFilters(filters);
    return textResult(
      total === 0
        ? 'Switchyard manages no services yet. Add a definition under services.d/ and run apply_config_reload.'
        : `No service matches ${active}. ${total} service(s) configured — call list_services without filters to see them.`,
      { services: [], total, matched: 0 },
    );
  }

  const rows = services.map((service) => [
    service.id,
    service.state,
    service.type,
    service.group,
    service.busy ? `busy: ${service.busy.label}` : (service.statusSummary ?? ''),
    alertCell(service),
    service.monitored ? 'yes' : 'no',
    service.supportsLogs ? 'yes' : 'no',
    actionList(service.actions),
  ]);

  const counts = countStates(services);
  const header =
    `${services.length} of ${total} service(s)` +
    (describeFilters(filters) ? ` matching ${describeFilters(filters)}` : '') +
    ` — ${counts}`;

  return textResult(
    lines(
      header,
      '',
      table(['ID', 'STATE', 'PROVIDER', 'GROUP', 'SUMMARY', 'ALERTS', 'SAMPLED', 'LOGS', 'ACTIONS'], rows),
      '',
      'An action id marked * needs confirm: true when calling run_action.',
    ),
    {
      total,
      matched: services.length,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        state: service.state,
        type: service.type,
        group: service.group,
        tags: service.tags,
        statusSummary: service.statusSummary,
        since: service.since,
        lastCheckedAt: service.lastCheckedAt,
        busy: service.busy ?? null,
        monitored: service.monitored,
        supportsLogs: service.supportsLogs,
        alerts: service.alerts.map((alert) => ({
          metric: alert.metric,
          severity: alert.severity,
          stale: alert.stale ?? false,
        })),
        actions: service.actions.map((action) => ({
          id: action.id,
          label: action.label,
          kind: action.kind,
          confirm: action.confirm === true,
          enabledIn: action.enabledIn,
        })),
      })),
    },
  );
}

function detailResult(detail: ServiceDetail): ToolResult {
  const now = Date.now();
  const text = lines(
    `${detail.id} — ${detail.name} (${detail.providerLabel}, group ${detail.group})`,
    detail.description,
    `State ${detail.state}` +
      (detail.since ? `, since ${detail.since} (${ageOf(detail.since, now)})` : '') +
      `, last checked ${ageOf(detail.lastCheckedAt, now)}` +
      (detail.busy ? ` — "${detail.busy.label}" running since ${detail.busy.startedAt}` : ''),
    detail.statusSummary && `Summary: ${detail.statusSummary}`,
    detail.statusDetail && `Detail: ${detail.statusDetail}`,
    detail.tags.length > 0 && `Tags: ${detail.tags.join(', ')}`,
    `Defined in ${detail.source}${detail.workdir ? `, workdir ${detail.workdir}` : ''}`,
    detail.envKeys.length > 0 && `Environment keys (values never exposed): ${detail.envKeys.join(', ')}`,
    '',
    section('Status metrics', detail.metrics.map((metric) => `${metric.label}: ${metric.value}`)),
    section(
      'Endpoints',
      [
        ...detail.urls.map((url) => `${url.label}: ${url.url}${url.primary ? ' (primary)' : ''}`),
        ...detail.ports.map(
          (port) =>
            `port ${port.hostPort ?? port.port}/${port.protocol}` +
            (port.label ? ` — ${port.label}` : '') +
            (port.hostPort && port.hostPort !== port.port ? ` → container ${port.port}` : ''),
        ),
      ],
    ),
    section(
      'Children',
      detail.childStatuses.map(
        (child) =>
          `${child.name}: ${child.stateLabel ?? child.state}` +
          (child.health && child.health !== 'none' ? ` (${child.health})` : '') +
          (child.image ? ` — ${child.image}` : ''),
      ),
    ),
    section('Warnings', detail.warnings),
    section('Errors', detail.errors),
    resourceSection(detail, now),
    section(
      'Actions',
      detail.actions.map(
        (action) =>
          `${action.id}${action.confirm ? '*' : ''} — ${action.label} [${action.kind}]` +
          (action.enabledIn?.length ? `, enabled in ${action.enabledIn.join('/')}` : '') +
          (action.description ? `: ${action.description}` : ''),
      ),
      '* needs confirm: true in run_action',
    ),
    section(
      'Recent actions',
      detail.history
        .slice(0, 5)
        .map(
          (record) =>
            `${record.startedAt} ${record.actionId} ${record.ok ? 'ok' : 'FAILED'} ` +
            `(${formatDuration(record.durationMs)}${record.exitCode === null || record.exitCode === undefined ? '' : `, exit ${record.exitCode}`}) ${record.message}`,
        ),
    ),
    detail.supportsLogs ? 'Logs available — call get_logs.' : 'This service exposes no logs.',
  );

  return textResult(text, { service: detail as unknown as Record<string, unknown> });
}

function resourceSection(detail: ServiceDetail, now: number): string {
  if (!detail.monitored) return section('Resources', ['not sampled (monitoring off, or the provider cannot sample)']);
  const sample = detail.resources;
  if (!sample) {
    return section('Resources', [`no sample yet (service is ${detail.state})`]);
  }

  const thresholds = detail.monitoringConfig?.thresholds ?? {};
  const entries: string[] = [
    `sampled ${sample.at} (${ageOf(sample.at, now)}) — ${sample.attribution}`,
  ];
  // Reuses the resource-view metric renderer by projecting the sample into the
  // same shape; the drawer-style detail endpoint predates /api/resources and
  // carries values and thresholds separately.
  for (const [metric, field] of METRIC_FIELDS) {
    const value = sample[field];
    if (value === undefined) continue;
    const threshold = thresholds[metric];
    entries.push(
      formatMetric({
        metric,
        label: metric,
        unit: threshold?.unit ?? defaultUnit(metric),
        value,
        state: threshold ? 'ok' : 'no-threshold',
        ...(threshold?.warning !== undefined ? { warning: threshold.warning } : {}),
        ...(threshold?.critical !== undefined ? { critical: threshold.critical } : {}),
        ...(threshold?.warning ? { percentOfWarning: (value / threshold.warning) * 100 } : {}),
      }),
    );
  }
  if (detail.alerts.length > 0) {
    entries.push(
      `active alerts: ${detail.alerts.map((alert) => `${alert.metric} ${alert.severity}`).join(', ')} — see get_alerts`,
    );
  }
  entries.push('call get_resource_usage for thresholds and state, get_resource_history for the trend');
  return section('Resources', entries);
}

const METRIC_FIELDS: [
  'cpu' | 'memory' | 'diskRead' | 'diskWrite' | 'netRx' | 'netTx',
  'cpuPercent' | 'memoryBytes' | 'diskReadBps' | 'diskWriteBps' | 'netRxBps' | 'netTxBps',
][] = [
  ['cpu', 'cpuPercent'],
  ['memory', 'memoryBytes'],
  ['diskRead', 'diskReadBps'],
  ['diskWrite', 'diskWriteBps'],
  ['netRx', 'netRxBps'],
  ['netTx', 'netTxBps'],
];

function defaultUnit(metric: string): 'percent' | 'bytes' | 'bytesPerSecond' {
  if (metric === 'cpu') return 'percent';
  if (metric === 'memory') return 'bytes';
  return 'bytesPerSecond';
}

function section(title: string, entries: string[], footer?: string): string {
  if (entries.length === 0) return '';
  return lines(`${title}:`, ...entries.map((entry) => `  ${entry}`), footer && `  ${footer}`, '');
}

function actionList(actions: ActionDescriptor[]): string {
  if (actions.length === 0) return '—';
  return actions.map((action) => `${action.id}${action.confirm ? '*' : ''}`).join(', ');
}

function alertCell(service: ServiceSummary): string {
  if (service.alerts.length === 0) return '—';
  const critical = service.alerts.filter((alert) => alert.severity === 'critical').length;
  const warning = service.alerts.length - critical;
  return [critical ? `${critical} crit` : undefined, warning ? `${warning} warn` : undefined]
    .filter(Boolean)
    .join(' + ');
}

function countStates(services: ServiceSummary[]): string {
  const counts = new Map<ServiceState, number>();
  for (const service of services) counts.set(service.state, (counts.get(service.state) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
}

function describeFilters(filters: { group?: string; state?: string; tag?: string }): string {
  return Object.entries(filters)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}
