import type { MetricTone, ServiceState } from './types';

export interface StateStyle {
  label: string;
  /** CSS colour reference for text/border/glow. */
  color: string;
  /** Tailwind classes for the badge chip. */
  chip: string;
  /** Short helper sentence shown in tooltips and the drawer. */
  hint: string;
  /** Indicator shape — status is never carried by colour alone. */
  shape: 'pulse' | 'hollow' | 'spinner' | 'triangle' | 'cross' | 'question';
  /** Sort weight: worst first when sorting by status. */
  severity: number;
}

export const STATE_STYLES: Record<ServiceState, StateStyle> = {
  running: {
    label: 'Running',
    color: '#10b981',
    chip: 'text-emerald-500 border-emerald-500/35 bg-emerald-500/10',
    hint: 'Service is up and reporting healthy.',
    shape: 'pulse',
    severity: 60,
  },
  starting: {
    label: 'Starting',
    color: '#0ea5e9',
    chip: 'text-sky-500 border-sky-500/35 bg-sky-500/10',
    hint: 'A start or restart is in progress.',
    shape: 'spinner',
    severity: 30,
  },
  stopping: {
    label: 'Stopping',
    color: '#fbbf24',
    chip: 'text-amber-400 border-amber-400/35 bg-amber-400/10',
    hint: 'A stop is in progress.',
    shape: 'spinner',
    severity: 31,
  },
  degraded: {
    label: 'Degraded',
    color: '#f59e0b',
    chip: 'text-amber-500 border-amber-500/35 bg-amber-500/10',
    hint: 'Up, but not fully healthy — check warnings.',
    shape: 'triangle',
    severity: 20,
  },
  failed: {
    label: 'Failed',
    color: '#ef4444',
    chip: 'text-red-500 border-red-500/35 bg-red-500/10',
    hint: 'The service exited with an error.',
    shape: 'cross',
    severity: 10,
  },
  stopped: {
    label: 'Stopped',
    color: '#64748b',
    chip: 'text-slate-500 border-slate-500/35 bg-slate-500/10',
    hint: 'Not running — this may be intentional.',
    shape: 'hollow',
    severity: 50,
  },
  unknown: {
    label: 'Unknown',
    color: '#8b5cf6',
    chip: 'text-violet-500 border-violet-500/35 bg-violet-500/10',
    hint: 'Status could not be determined.',
    shape: 'question',
    severity: 40,
  },
};

export const STATE_ORDER: ServiceState[] = [
  'running',
  'degraded',
  'failed',
  'starting',
  'stopping',
  'stopped',
  'unknown',
];

export function stateStyle(state: ServiceState): StateStyle {
  return STATE_STYLES[state] ?? STATE_STYLES.unknown;
}

/** True while an action is expected to change the state shortly. */
export function isTransitional(state: ServiceState): boolean {
  return state === 'starting' || state === 'stopping';
}

export interface ToneStyle {
  /** Foreground only — for a value sitting in an otherwise neutral row. */
  text: string;
  /** Border, tinted fill and text — for a chip or callout that stands alone. */
  chip: string;
}

/**
 * How a severity reads on screen. Card, table and drawer all show the same
 * alert, so the colours are decided here rather than re-derived from
 * `alert.severity` at every call site.
 */
export const TONE_STYLES: Record<MetricTone, ToneStyle> = {
  default: { text: 'text-foreground', chip: 'border-border bg-popover/50 text-muted-foreground' },
  good: { text: 'text-emerald-500', chip: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500' },
  warn: { text: 'text-amber-500', chip: 'border-amber-500/30 bg-amber-500/10 text-amber-500' },
  bad: { text: 'text-red-500', chip: 'border-red-500/30 bg-red-500/10 text-red-500' },
};

export function toneStyle(tone: MetricTone = 'default'): ToneStyle {
  return TONE_STYLES[tone] ?? TONE_STYLES.default;
}
