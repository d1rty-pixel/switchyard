import { z } from 'zod';
import { ageOf, lines } from '../format.js';
import { guard, serviceIdParam, textResult } from './shared.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SwitchyardClient } from '../client.js';

/**
 * Log tail for one service.
 *
 * Container names are passed through as given; the server re-validates each one
 * against the service's actual children before it reaches a provider's argv, so a
 * name invented here is dropped rather than executed.
 */

export function registerLogTools(server: McpServer, client: SwitchyardClient): void {
  server.registerTool(
    'get_logs',
    {
      title: 'Read a service log tail',
      description:
        'Recent log lines for one service, from whatever source its provider uses ' +
        '(journalctl, docker logs, a log file). Optionally restrict a compose stack to ' +
        'specific containers. Services that expose no logs report that instead.',
      inputSchema: {
        service: serviceIdParam,
        tail: z.coerce
          .number()
          .int()
          .min(10)
          .max(5_000)
          .optional()
          .describe('Number of lines (10–5000, default is the server setting, usually 200)'),
        containers: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Compose service or container names to restrict output to, as listed by get_service. ' +
              'Names the service does not actually have are ignored by the server',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard(async () => {
        const query: { tail?: number; containers?: string } = {};
        if (args.tail !== undefined) query.tail = args.tail;
        if (args.containers?.length) query.containers = args.containers.join(',');

        const payload = await client.logs(args.service, query);
        const header =
          `${payload.id} — ${payload.lines.length} line(s) from ${payload.source}` +
          (payload.truncated ? ' (truncated)' : '') +
          `, fetched ${ageOf(payload.fetchedAt)}` +
          (args.containers?.length ? `, restricted to ${args.containers.join(', ')}` : '');

        return textResult(
          lines(
            header,
            '',
            payload.lines.length > 0 ? payload.lines.join('\n') : '(no log lines returned)',
          ),
          payload as unknown as Record<string, unknown>,
        );
      }),
  );
}
