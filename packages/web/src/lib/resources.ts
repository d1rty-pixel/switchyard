import type { MetricTone, ResourceAlert, ResourceMetric, ResourceUnit, ResourceValues } from './types';

/**
 * Frontend view of the resource model. Mirrors the server's
 * `core/resources.ts` — see the note at the top of `types.ts` about why the wire
 * shape is hand-copied rather than imported.
 */
export const RESOURCE_METRIC_INFO: Record<
  ResourceMetric,
  { label: string; short: string; unit: ResourceUnit; field: keyof ResourceValues }
> = {
  cpu: { label: 'CPU', short: 'CPU', unit: 'percent', field: 'cpuPercent' },
  memory: { label: 'Memory', short: 'MEM', unit: 'bytes', field: 'memoryBytes' },
  diskRead: { label: 'Disk read', short: 'RD', unit: 'bytesPerSecond', field: 'diskReadBps' },
  diskWrite: { label: 'Disk write', short: 'WR', unit: 'bytesPerSecond', field: 'diskWriteBps' },
  netRx: { label: 'Net in', short: 'IN', unit: 'bytesPerSecond', field: 'netRxBps' },
  netTx: { label: 'Net out', short: 'OUT', unit: 'bytesPerSecond', field: 'netTxBps' },
};

/** Display order: the two metrics that matter on a card come first. */
export const RESOURCE_ORDER: ResourceMetric[] = ['cpu', 'memory', 'diskRead', 'diskWrite', 'netRx', 'netTx'];

export interface ResourceEntry {
  metric: ResourceMetric;
  label: string;
  short: string;
  unit: ResourceUnit;
  value: number;
  alert?: ResourceAlert;
}

/** The measured metrics of a sample, in display order. */
export function resourceEntries(values: ResourceValues, alerts: ResourceAlert[] = []): ResourceEntry[] {
  const byMetric = new Map(alerts.map((alert) => [alert.metric, alert]));
  const entries: ResourceEntry[] = [];
  for (const metric of RESOURCE_ORDER) {
    const info = RESOURCE_METRIC_INFO[metric];
    const value = values[info.field];
    if (value === undefined) continue;
    const entry: ResourceEntry = { metric, label: info.label, short: info.short, unit: info.unit, value };
    const alert = byMetric.get(metric);
    if (alert) entry.alert = alert;
    entries.push(entry);
  }
  return entries;
}

export function alertTone(severity?: 'warning' | 'critical'): MetricTone {
  if (severity === 'critical') return 'bad';
  if (severity === 'warning') return 'warn';
  return 'default';
}

/** Highest severity among a set of alerts, for one-glance badges. */
export function worstSeverity(alerts: ResourceAlert[]): 'warning' | 'critical' | undefined {
  if (alerts.some((alert) => alert.severity === 'critical')) return 'critical';
  if (alerts.length > 0) return 'warning';
  return undefined;
}
