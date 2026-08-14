import type { MetricTone, ServiceState } from './types';

export interface StateStyle {
  label: string;
  /** CSS colour reference for text/border/glow — a theme token, not a literal. */
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
    color: 'var(--tone-good)',
    chip: 'text-good border-good/35 bg-good/10',
    hint: 'Service is up and reporting healthy.',
    shape: 'pulse',
    severity: 60,
  },
  starting: {
    label: 'Starting',
    color: 'var(--tone-info)',
    chip: 'text-info border-info/35 bg-info/10',
    hint: 'A start or restart is in progress.',
    shape: 'spinner',
    severity: 30,
  },
  stopping: {
    label: 'Stopping',
    color: 'var(--tone-warn)',
    chip: 'text-warn border-warn/35 bg-warn/10',
    hint: 'A stop is in progress.',
    shape: 'spinner',
    severity: 31,
  },
  degraded: {
    label: 'Degraded',
    color: 'var(--tone-warn)',
    chip: 'text-warn border-warn/35 bg-warn/10',
    hint: 'Up, but not fully healthy — check warnings.',
    shape: 'triangle',
    severity: 20,
  },
  failed: {
    label: 'Failed',
    color: 'var(--tone-bad)',
    chip: 'text-bad border-bad/35 bg-bad/10',
    hint: 'The service exited with an error.',
    shape: 'cross',
    severity: 10,
  },
  stopped: {
    label: 'Stopped',
    color: 'var(--tone-neutral)',
    chip: 'text-neutral border-neutral/35 bg-neutral/10',
    hint: 'Not running — this may be intentional.',
    shape: 'hollow',
    severity: 50,
  },
  unknown: {
    label: 'Unknown',
    color: 'var(--tone-unknown)',
    chip: 'text-unknown border-unknown/35 bg-unknown/10',
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
  default: { text: 'text-foreground', chip: 'border-border bg-muted/50 text-muted-foreground' },
  good: { text: 'text-good', chip: 'border-good/30 bg-good/10 text-good' },
  warn: { text: 'text-warn', chip: 'border-warn/30 bg-warn/10 text-warn' },
  bad: { text: 'text-bad', chip: 'border-bad/30 bg-bad/10 text-bad' },
};

export function toneStyle(tone: MetricTone = 'default'): ToneStyle {
  return TONE_STYLES[tone] ?? TONE_STYLES.default;
}
