import { formatBytes, formatDuration, lines } from '../format.js';
import { guard, textResult } from './shared.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SwitchyardClient } from '../client.js';
import type { ConfigDiff, MetaResponse } from '../wire.js';

/**
 * Orientation and configuration reload.
 *
 * `switchyard_server_info` merges health and metadata into one call because the
 * two answer the same question — "what am I connected to, and what does it know?"
 * The host facts are part of that answer: a `warning: 150%` CPU threshold means
 * something different on 4 threads than on 14.
 *
 * Reload is split into preview and apply rather than taking a boolean, so the
 * read-only half can be annotated and used freely while the half that swaps the
 * live configuration stays a separate, deliberate call.
 */

export function registerAdminTools(server: McpServer, client: SwitchyardClient): void {
  server.registerTool(
    'switchyard_server_info',
    {
      title: 'Switchyard server and host info',
      description:
        'Version, uptime, config path, service directories, config warnings, disabled services, ' +
        'groups, available providers, monitoring settings and host facts (CPU threads, RAM) needed ' +
        'to interpret absolute resource thresholds. Good first call for orientation.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const [health, meta] = await Promise.all([client.health(), client.meta()]);
        return textResult(infoText(client.baseUrl, health.uptimeMs, health.services, health.subscribers, meta), {
          baseUrl: client.baseUrl,
          health: health as unknown as Record<string, unknown>,
          meta: meta as unknown as Record<string, unknown>,
        });
      }),
  );

  server.registerTool(
    'preview_config_reload',
    {
      title: 'Preview a configuration reload',
      description:
        'Parse the configuration files on disk and report what a reload would change — services ' +
        'added, removed or modified — without applying anything. Also surfaces parse warnings.',
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () =>
      guard(async () => {
        const preview = await client.reloadPreview();
        return textResult(
          lines(
            `Preview of ${preview.path}: ${preview.services} service(s) would be configured.`,
            diffText(preview.diff),
            preview.warnings.length > 0
              ? lines('Warnings:', ...preview.warnings.map((warning) => `  ${warning}`))
              : 'No configuration warnings.',
            changesPending(preview.diff)
              ? 'Call apply_config_reload to make this live.'
              : 'Nothing to apply.',
          ),
          preview as unknown as Record<string, unknown>,
        );
      }),
  );

  server.registerTool(
    'apply_config_reload',
    {
      title: 'Apply a configuration reload',
      description:
        'Re-read the configuration from disk and swap it into the running server. Rejected while ' +
        'any action is in flight. Preview it first with preview_config_reload. Resource sample ' +
        'history for a service is discarded if its provider changed.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async () =>
      guard(async () => {
        const result = await client.reload();
        return textResult(
          lines(
            `Reloaded ${result.path} — ${result.services} service(s) now configured.`,
            result.warnings.length > 0
              ? lines('Warnings:', ...result.warnings.map((warning) => `  ${warning}`))
              : 'No configuration warnings.',
          ),
          result as unknown as Record<string, unknown>,
        );
      }),
  );
}

function infoText(
  baseUrl: string,
  uptimeMs: number,
  services: number,
  subscribers: number,
  meta: MetaResponse,
): string {
  const { host, monitoring } = meta;
  return lines(
    `${meta.app.name} ${meta.app.version} at ${baseUrl}`,
    `Up ${formatDuration(uptimeMs)} · ${services} service(s) · ${subscribers} dashboard stream(s) connected`,
    `Config ${meta.configPath}`,
    `Service directories: ${meta.serviceDirs.join(', ') || '(none)'}`,
    `Host ${host.hostname}: ${host.cpuCount} CPU threads (100% = one core, ${host.cpuCount * 100}% = the whole machine), ` +
      `${formatBytes(host.totalMemoryBytes)} RAM`,
    monitoring.enabled
      ? `Monitoring on · sample every ${formatDuration(monitoring.intervalMs)} · history ${formatDuration(monitoring.historyMs)} · ` +
        `defaults for=${formatDuration(monitoring.defaults.forMs)} clearBelow=${monitoring.defaults.clearBelow} ` +
        `cooldown=${formatDuration(monitoring.defaults.cooldownMs)}`
      : 'Monitoring is switched off globally — no resource samples are taken.',
    `Metrics: ${monitoring.metrics.map((entry) => `${entry.metric} (${entry.unit})`).join(', ')}`,
    Object.keys(monitoring.thresholds).length > 0
      ? `Global thresholds inherited by every service: ${Object.keys(monitoring.thresholds).join(', ')}`
      : 'No global thresholds — thresholds are set per service.',
    `Providers: ${meta.providers.map((provider) => provider.type).join(', ')}`,
    `Groups: ${meta.groups.map((group) => group.id).join(', ')}`,
    meta.configWarnings.length > 0
      ? lines('Config warnings:', ...meta.configWarnings.map((warning) => `  ${warning}`))
      : 'No config warnings.',
    meta.disabledServices.length > 0
      ? `Disabled definitions (enabled: false): ${meta.disabledServices.map((service) => service.id).join(', ')}`
      : undefined,
    'Resource thresholds are absolute per-service values, so they only mean something on this host.',
  );
}

function diffText(diff: ConfigDiff): string {
  if (!changesPending(diff)) return `No changes — ${diff.unchanged} service(s) identical.`;
  return lines(
    diff.added.length > 0 ? `  added:   ${diff.added.join(', ')}` : undefined,
    diff.removed.length > 0 ? `  removed: ${diff.removed.join(', ')}` : undefined,
    diff.changed.length > 0 ? `  changed: ${diff.changed.join(', ')}` : undefined,
    `  unchanged: ${diff.unchanged}`,
  );
}

function changesPending(diff: ConfigDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}
