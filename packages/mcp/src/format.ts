import type {
  ResourceAlert,
  ResourceMetricView,
  ResourceUnit,
  ServiceResourceView,
  ThresholdState,
} from './wire.js';

/**
 * Rendering for the text half of every tool result.
 *
 * The text block is the part a client is guaranteed to show, so it carries the
 * whole answer — measurement, unit and the threshold it should be read against.
 * `structuredContent` repeats the same facts for programmatic use; it never holds
 * anything the text omits.
 */

export function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let size = Math.abs(value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const sign = value < 0 ? '-' : '';
  return `${sign}${round(size)} ${units[unit]}`;
}

export function formatPercent(value: number): string {
  return `${round(value)}%`;
}

export function formatRate(value: number): string {
  return `${formatBytes(value)}/s`;
}

/** Renders a measured value in the unit its metric is defined in. */
export function formatValue(value: number, unit: ResourceUnit): string {
  switch (unit) {
    case 'percent':
      return formatPercent(value);
    case 'bytes':
      return formatBytes(value);
    case 'bytesPerSecond':
      return formatRate(value);
  }
}

/** Compact wall-clock duration: `450ms`, `12s`, `3m 20s`, `2h 5m`, `4d 3h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const abs = Math.abs(Math.round(ms));
  if (abs < 1_000) return `${abs}ms`;
  const seconds = Math.floor(abs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/** `12s ago`, or `just now` for a sample younger than a second. */
export function formatAge(ms: number | undefined): string {
  if (ms === undefined) return 'never';
  return ms < 1_000 ? 'just now' : `${formatDuration(ms)} ago`;
}

/** Age of an ISO timestamp relative to now. */
export function ageOf(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 'unknown' : formatAge(now - parsed);
}

/** Fractions arrive as 0–1; show them as whole percents of the samples seen. */
export function formatFraction(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * One metric as a phrase that carries its own threshold context, e.g.
 * `cpu 3.9% (26% of warning 15%)` or `memory 1.7 GiB [WARNING ≥ 2 GiB]`.
 */
export function formatMetric(metric: ResourceMetricView): string {
  const head = `${metric.metric} ${metric.value === undefined ? '—' : formatValue(metric.value, metric.unit)}`;
  const context = thresholdContext(metric);
  return context ? `${head} ${context}` : head;
}

function thresholdContext(metric: ResourceMetricView): string {
  switch (metric.state) {
    case 'critical':
    case 'warning': {
      const limit = metric.state === 'critical' ? metric.critical : metric.warning;
      const shown = limit === undefined ? '' : ` ≥ ${formatValue(limit, metric.unit)}`;
      return `[${metric.state.toUpperCase()}${shown}]`;
    }
    case 'pending': {
      const held = metric.breachingForMs === undefined ? '' : formatDuration(metric.breachingForMs);
      const left = metric.activatesInMs === undefined ? '' : `, alerts in ${formatDuration(metric.activatesInMs)}`;
      return `[over ${metric.pendingSeverity ?? 'warning'} for ${held}${left}]`;
    }
    case 'ok': {
      // Percentage of the nearest configured threshold is the useful number
      // here: it says how much headroom is left without needing a second lookup.
      if (metric.percentOfWarning !== undefined && metric.warning !== undefined) {
        return `(${round(metric.percentOfWarning)}% of warning ${formatValue(metric.warning, metric.unit)})`;
      }
      if (metric.percentOfCritical !== undefined && metric.critical !== undefined) {
        return `(${round(metric.percentOfCritical)}% of critical ${formatValue(metric.critical, metric.unit)})`;
      }
      return '';
    }
    case 'unmeasured': {
      const parts = [
        metric.warning !== undefined ? `warning ${formatValue(metric.warning, metric.unit)}` : undefined,
        metric.critical !== undefined ? `critical ${formatValue(metric.critical, metric.unit)}` : undefined,
      ].filter(Boolean);
      return parts.length > 0 ? `(no measurement; threshold ${parts.join('/')} cannot fire)` : '(no measurement)';
    }
    case 'no-threshold':
      return '';
  }
}

/** Why a service is showing no numbers, in one clause. */
export function samplingNote(view: ServiceResourceView): string | undefined {
  switch (view.sampling) {
    case 'off':
      return view.monitored ? undefined : 'sampling off for this service (or its provider cannot sample)';
    case 'paused':
      return 'sampling paused while an action runs';
    case 'no-sample':
      return `nothing to measure (service is ${view.state})`;
    case 'ok':
      return undefined;
  }
}

export function formatAlert(alert: ResourceAlert, now = Date.now()): string {
  const activated = Date.parse(alert.activatedAt);
  const held = Number.isNaN(activated) ? 'unknown' : formatDuration(now - activated);
  const stale = alert.stale ? ' [STALE — no fresh samples]' : '';
  return (
    `${alert.severity.toUpperCase()} ${alert.serviceId} ${alert.metric} ` +
    `${formatValue(alert.value, alert.unit)} ≥ ${formatValue(alert.threshold, alert.unit)} ` +
    `for ${held} (breach began ${alert.breachedAt}, alert active since ${alert.activatedAt})${stale}`
  );
}

/** Worst-state marker used at the start of a service line. */
export function stateMarker(state: ThresholdState): string {
  switch (state) {
    case 'critical':
      return 'CRIT';
    case 'warning':
      return 'WARN';
    case 'pending':
      return 'PEND';
    default:
      return '  ok';
  }
}

/**
 * Fixed-width table. Columns are padded to their widest cell so a list of
 * services stays scannable; a single trailing column is left unpadded so long
 * free text does not drag a trailing edge of spaces behind it.
 */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd();
  return [render(headers), ...rows.map(render)].join('\n');
}

/** Joins non-empty lines, dropping the undefined ones callers produce. */
export function lines(...entries: (string | undefined | false)[]): string {
  return entries.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).join('\n');
}

export function round(value: number): number {
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value);
  if (abs >= 10) return Math.round(value * 10) / 10;
  return Math.round(value * 100) / 100;
}
