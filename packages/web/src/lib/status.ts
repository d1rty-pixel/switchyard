import type { ServiceState } from './types';

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
    color: 'var(--color-st-running)',
    chip: 'text-st-running border-st-running/35 bg-st-running/10',
    hint: 'Service is up and reporting healthy.',
    shape: 'pulse',
    severity: 60,
  },
  starting: {
    label: 'Starting',
    color: 'var(--color-st-starting)',
    chip: 'text-st-starting border-st-starting/35 bg-st-starting/10',
    hint: 'A start or restart is in progress.',
    shape: 'spinner',
    severity: 30,
  },
  stopping: {
    label: 'Stopping',
    color: 'var(--color-st-stopping)',
    chip: 'text-st-stopping border-st-stopping/35 bg-st-stopping/10',
    hint: 'A stop is in progress.',
    shape: 'spinner',
    severity: 31,
  },
  degraded: {
    label: 'Degraded',
    color: 'var(--color-st-degraded)',
    chip: 'text-st-degraded border-st-degraded/35 bg-st-degraded/10',
    hint: 'Up, but not fully healthy — check warnings.',
    shape: 'triangle',
    severity: 20,
  },
  failed: {
    label: 'Failed',
    color: 'var(--color-st-failed)',
    chip: 'text-st-failed border-st-failed/35 bg-st-failed/10',
    hint: 'The service exited with an error.',
    shape: 'cross',
    severity: 10,
  },
  stopped: {
    label: 'Stopped',
    color: 'var(--color-st-stopped)',
    chip: 'text-st-stopped border-st-stopped/35 bg-st-stopped/10',
    hint: 'Not running — this may be intentional.',
    shape: 'hollow',
    severity: 50,
  },
  unknown: {
    label: 'Unknown',
    color: 'var(--color-st-unknown)',
    chip: 'text-st-unknown border-st-unknown/35 bg-st-unknown/10',
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
