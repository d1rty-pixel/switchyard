import type { Metric } from './types';

/** Compact duration: 3d 4h, 5h 12m, 8m 20s, 12s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/**
 * Coarse duration for continuously displayed values (uptime, "checked … ago").
 *
 * Seconds are dropped past the first minute on purpose: a label that changes
 * every second changes width every second, and a grid of cards that reflows once
 * a second is visually noisy for information nobody reads at that resolution.
 */
export function formatDurationCoarse(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatUptime(since?: string | null): string | undefined {
  if (!since) return undefined;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return undefined;
  return formatDurationCoarse(Date.now() - started);
}

/**
 * "just now", "2m ago", "3h ago" — used for the last status check. Deliberately
 * has no per-second resolution; see `formatDurationCoarse`.
 */
export function formatAgo(iso?: string | null): string {
  if (!iso) return 'never';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'never';
  const delta = Date.now() - time;
  if (delta < 45_000) return 'just now';
  if (delta < 90_000) return '1m ago';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

export function formatClock(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/** Renders a provider metric according to its declared kind. */
export function formatMetric(metric: Metric): string {
  switch (metric.kind) {
    case 'bytes': {
      const numeric = Number(metric.value);
      return Number.isFinite(numeric) ? formatBytes(numeric) : metric.value;
    }
    case 'duration': {
      const numeric = Number(metric.value);
      return Number.isFinite(numeric) ? formatDuration(numeric) : metric.value;
    }
    case 'timestamp':
      return formatAgo(metric.value);
    default:
      return metric.value;
  }
}

/** Long paths are truncated in the middle, keeping both ends readable. */
export function ellipsisMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
