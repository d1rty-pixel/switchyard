import { z } from 'zod';
import { ApiError, UnreachableError } from '../client.js';

/**
 * Shared plumbing for the tool handlers.
 *
 * Two rules live here. Every result carries its full answer in the text block,
 * with `structuredContent` as a machine-readable mirror rather than the only copy.
 * And every failure comes back as a tool result the model can read, not a
 * transport-level exception: "Switchyard is not running" is an answer.
 */

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: 'text', text }] };
  if (structuredContent !== undefined) result.structuredContent = structuredContent;
  return result;
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Turns the client's exceptions into readable tool results.
 *
 * The API's own error codes are kept verbatim — `not_found` for an unknown
 * service or action, `conflict` for an action already running, `unsupported` for a
 * service with no logs — because they are the same distinctions the dashboard
 * makes, and an agent should not have to guess from prose.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UnreachableError) return errorResult(error.message);
    if (error instanceof ApiError) return errorResult(`${error.code}: ${error.message}${detailsOf(error)}`);
    return errorResult(`unexpected failure: ${(error as Error).message}`);
  }
}

/**
 * A rejected configuration carries a list of per-file, per-field problems, and
 * that list *is* the answer — rendering it as pretty-printed JSON buries the one
 * line someone has to act on.
 */
function detailsOf(error: ApiError): string {
  if (error.details === undefined) return '';
  const issues = (error.details as { issues?: unknown }).issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return `\n${issues.map((issue) => `  • ${String(issue)}`).join('\n')}`;
  }
  return `\ndetails: ${JSON.stringify(error.details, null, 2)}`;
}

/**
 * Service and action parameters are ids only, matching the server's own schemas.
 * There is deliberately no way to pass a command, an argument, a path or a
 * provider setting through this interface: the id is looked up in tables built
 * from the configuration, exactly as the dashboard does it.
 */
export const serviceIdParam = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,63}$/,
    'service id: lowercase letters, digits, dot, dash or underscore (max 64)',
  )
  .describe('Service id exactly as reported by list_services');

export const actionIdParam = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,31}$/,
    'action id: lowercase letters, digits, dot, dash or underscore (max 32)',
  )
  .describe('Action id from the service\'s own action list (get_service / list_services)');

export const RESOURCE_METRIC_PARAM = ['cpu', 'memory', 'diskRead', 'diskWrite', 'netRx', 'netTx'] as const;
