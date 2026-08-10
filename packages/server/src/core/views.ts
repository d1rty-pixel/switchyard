import type {
  ActionDescriptor,
  ActionRecord,
  ChildStatus,
  CommandOutput,
  Metric,
  PortInfo,
  ServiceState,
  UrlInfo,
} from '../types.js';

/** Card-level projection of a service. Kept small: it travels over SSE. */
export interface ServiceSummary {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  type: string;
  providerLabel: string;
  group: string;
  tags: string[];
  order?: number;

  state: ServiceState;
  statusSummary?: string;
  since?: string | null;
  lastCheckedAt?: string | null;
  checking: boolean;
  busy?: { actionId: string; label: string; startedAt: string } | null;

  metrics: Metric[];
  warnings: string[];
  errors: string[];
  ports: PortInfo[];
  urls: UrlInfo[];
  actions: ActionDescriptor[];
  supportsLogs: boolean;
  children?: { total: number; running: number };
  lastAction?: ActionRecord | null;
}

/** Drawer-level projection: everything the summary has, plus diagnostics. */
export interface ServiceDetail extends ServiceSummary {
  statusDetail?: string;
  childStatuses: ChildStatus[];
  history: ActionRecord[];
  raw?: Record<string, string>;
  lastProbe?: CommandOutput;
  workdir?: string;
  /** File this service is defined in. */
  source: string;
  /** Names only — values are never sent to the browser. */
  envKeys: string[];
  providerConfig: unknown;
}

const SECRET_KEY = /(pass|secret|token|credential|apikey|api_key|private)/i;

/**
 * Provider config is shown in the drawer for debugging. It comes from a trusted
 * file, but it may still contain credentials; redact the obvious cases rather
 * than shipping them to a browser tab.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '«redacted»' : redact(entry);
    }
    return out;
  }
  return value;
}

export function childRollup(children?: ChildStatus[]): { total: number; running: number } | undefined {
  if (!children || children.length === 0) return undefined;
  return {
    total: children.length,
    running: children.filter((child) => child.state === 'running').length,
  };
}

export type { ActionDescriptor, ActionRecord, ChildStatus, Metric, PortInfo, UrlInfo };
