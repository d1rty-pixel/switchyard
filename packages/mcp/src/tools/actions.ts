import { z } from 'zod';
import { formatDuration, lines } from '../format.js';
import { actionIdParam, errorResult, guard, serviceIdParam, textResult, type ToolResult } from './shared.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SwitchyardClient } from '../client.js';
import type { ActionResponse, ServiceDetail } from '../wire.js';

/**
 * Running actions and forcing a status re-probe.
 *
 * `run_action` dispatches by id only. The id is looked up in the provider's action
 * table on the server, which is the same table the dashboard renders and the same
 * one that authorises the request — there is no way to pass a command, an
 * argument or a path through this tool.
 *
 * The confirmation rule is enforced here, in the handler, and not left to
 * annotations: `destructiveHint` is advice to a client that may or may not read
 * it, whereas an action the configuration marks `confirm: true` must not run just
 * because a model asked politely. The check reads the descriptor from the server,
 * so `confirm:` entries in a service file take effect without anything being
 * duplicated in this package.
 */

export function registerActionTools(server: McpServer, client: SwitchyardClient): void {
  server.registerTool(
    'run_action',
    {
      title: 'Run a Switchyard action',
      description:
        'Execute one of a service\'s declared actions — start, stop, restart, pull, and whatever ' +
        'else its provider exposes. Only action ids that appear in the service\'s own action list ' +
        'can be run. Actions the configuration marks as needing confirmation are refused unless ' +
        'confirm: true is passed. Returns the outcome, exit code, output excerpt and the new state.',
      inputSchema: {
        service: serviceIdParam,
        action: actionIdParam,
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Required (true) for actions marked as needing confirmation, the same ones the ' +
              'dashboard asks about before running. Ignored for the rest',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async (args) =>
      guard(async () => {
        const detail = await client.service(args.service);
        const descriptor = detail.actions.find((action) => action.id === args.action);

        if (!descriptor) {
          return errorResult(
            lines(
              `not_found: "${args.action}" is not an action of ${args.service}.`,
              `Available: ${detail.actions.map((action) => action.id).join(', ') || '(none)'}`,
            ),
          );
        }

        if (descriptor.confirm === true && args.confirm !== true) {
          return errorResult(
            lines(
              `"${descriptor.label}" (${descriptor.id}) on ${args.service} needs confirmation and was NOT run.`,
              descriptor.description ? `It would: ${descriptor.description}` : undefined,
              `The service is currently ${detail.state}.`,
              'Call run_action again with confirm: true if this is intended.',
            ),
          );
        }

        const advisory =
          descriptor.enabledIn?.length && !descriptor.enabledIn.includes(detail.state)
            ? `Note: the dashboard offers "${descriptor.id}" only in ${descriptor.enabledIn.join('/')}, ` +
              `and ${args.service} is ${detail.state}. Running it anyway.`
            : undefined;

        const result = await client.runAction(args.service, args.action);
        return actionResult(result, detail, advisory);
      }),
  );

  server.registerTool(
    'refresh_service',
    {
      title: 'Re-probe one service now',
      description:
        'Force an immediate status probe instead of waiting for the background poll, and return ' +
        'the fresh state. Does not change the service itself. Note that resource samples are ' +
        'taken on their own schedule and are not refreshed by this.',
      inputSchema: { service: serviceIdParam },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (args) =>
      guard(async () => {
        const { service } = await client.refresh(args.service);
        return textResult(
          lines(
            `${service.id} is ${service.state}${service.statusSummary ? ` — ${service.statusSummary}` : ''}`,
            service.since ? `In this state since ${service.since}` : undefined,
            `Probed at ${service.lastCheckedAt}`,
            service.warnings.length > 0 ? `Warnings: ${service.warnings.join('; ')}` : undefined,
            service.errors.length > 0 ? `Errors: ${service.errors.join('; ')}` : undefined,
          ),
          { service: service as unknown as Record<string, unknown> },
        );
      }),
  );
}

function actionResult(result: ActionResponse, before: ServiceDetail, advisory?: string): ToolResult {
  const { record, service, output } = result;
  const exit = record.exitCode === null || record.exitCode === undefined ? '' : `, exit ${record.exitCode}`;

  // A failed command is a successful call that reports failure, so the text has to
  // say which of the two happened without relying on the caller reading isError.
  const text = lines(
    advisory,
    `${result.ok ? 'ok' : 'FAILED'} — ${record.label} on ${service.id} ` +
      `(${formatDuration(record.durationMs)}${exit})`,
    result.message,
    `State: ${before.state} → ${service.state}${service.statusSummary ? ` (${service.statusSummary})` : ''}`,
    service.busy ? `Still busy: ${service.busy.label} since ${service.busy.startedAt}` : undefined,
    excerpt('stdout', output?.stdout),
    excerpt('stderr', output?.stderr),
    service.warnings.length > 0 ? `Warnings: ${service.warnings.join('; ')}` : undefined,
  );

  const payload: ToolResult = textResult(text, {
    ok: result.ok,
    message: result.message,
    record: record as unknown as Record<string, unknown>,
    stateBefore: before.state,
    stateAfter: service.state,
    service: service as unknown as Record<string, unknown>,
  });
  // The command failing is a real outcome the model should treat as a failure,
  // while the call itself succeeded — mark it so both readings are available.
  if (!result.ok) payload.isError = true;
  return payload;
}

/** Keeps command output useful without pasting a build log into the transcript. */
function excerpt(label: string, value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const all = trimmed.split('\n');
  const kept = all.slice(-20);
  const omitted = all.length - kept.length;
  return lines(
    `${label}${omitted > 0 ? ` (last 20 of ${all.length} lines)` : ''}:`,
    ...kept.map((line) => `  ${line}`),
  );
}
