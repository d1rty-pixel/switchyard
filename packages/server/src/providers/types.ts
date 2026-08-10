import type { ZodType, ZodTypeDef } from 'zod';
import type { Logger } from '../core/logger.js';
import type { ExecFn, ExecRequest, ExecResult } from '../core/exec.js';
import type { ActionDescriptor, ActionOutcome, LogsResult, PortInfo, StatusResult, UrlInfo } from '../types.js';
import type { ServiceBase } from '../config/schema.js';

/**
 * A service definition after config validation: base fields plus a provider
 * config block already parsed by that provider's schema.
 */
export interface ResolvedService extends Omit<ServiceBase, 'ports' | 'urls' | 'provider'> {
  ports: PortInfo[];
  urls: UrlInfo[];
  provider: unknown;
  /** Effective command timeout for this service. */
  timeout: number;
  /** Absolute path of the file this service was defined in. */
  source: string;
}

/**
 * Everything a provider is allowed to touch. Providers get no direct access to
 * the HTTP layer, the config file or `child_process` — only this context.
 */
export interface ProviderContext<C = unknown> {
  service: ResolvedService;
  config: C;
  /** Runs argv with the service's cwd, env and timeout already applied. */
  exec: ExecFn;
  /** Same as `exec`, but for one-off overrides (e.g. a longer timeout). */
  execRaw: (request: ExecRequest) => Promise<ExecResult>;
  log: Logger;
}

export interface LogsOptions {
  tail: number;
}

/**
 * A provider adapts one class of service (systemd unit, compose stack, ...) to
 * Switchyard's status/action/logs model.
 *
 * Adding a provider means: implement this interface, register it in
 * `providers/index.ts`. Nothing else in the system needs to change.
 */
export interface Provider<C = unknown> {
  /** Value used as `type:` in switchyard.yaml. */
  readonly type: string;
  readonly label: string;
  readonly description: string;
  /**
   * Schema for the service's `provider:` block. The input type is deliberately
   * loose: schemas use `.default()`, so parsed output and YAML input differ.
   */
  readonly configSchema: ZodType<C, ZodTypeDef, unknown>;

  /**
   * The complete set of dispatchable actions for a service. The API rejects any
   * action id not present here, so this doubles as the authorisation table.
   */
  actions(context: Omit<ProviderContext<C>, 'exec' | 'execRaw' | 'log'>): ActionDescriptor[];

  status(context: ProviderContext<C>): Promise<StatusResult>;

  runAction(context: ProviderContext<C>, action: ActionDescriptor): Promise<ActionOutcome>;

  /** Whether `logs()` can be called for this service. */
  supportsLogs(context: Omit<ProviderContext<C>, 'exec' | 'execRaw' | 'log'>): boolean;

  logs?(context: ProviderContext<C>, options: LogsOptions): Promise<LogsResult>;
}

/** Convenience: split a captured stream into non-empty trailing lines. */
export function splitLines(text: string, limit?: number): string[] {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  return limit && lines.length > limit ? lines.slice(lines.length - limit) : lines;
}
