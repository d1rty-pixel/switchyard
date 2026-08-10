import clsx from 'clsx';
import { stateStyle } from '../lib/status';
import type { ServiceState } from '../lib/types';

/**
 * Status is expressed three ways at once — colour, shape and motion — so a
 * glance at a wall of cards is readable even for the states that share a hue
 * family (stopping/degraded) or for colour-blind viewers.
 */
export function StatusIndicator({ state, size = 12 }: { state: ServiceState; size?: number }) {
  const style = stateStyle(state);
  const box = { width: size, height: size, color: style.color } as const;

  switch (style.shape) {
    case 'pulse':
      return (
        <span
          className="relative inline-flex items-center justify-center rounded-full animate-pip"
          style={{ ...box, background: style.color }}
          aria-hidden
        />
      );

    case 'hollow':
      return (
        <span
          className="inline-block rounded-full border-2 bg-transparent"
          style={{ ...box, borderColor: style.color }}
          aria-hidden
        />
      );

    case 'spinner':
      return (
        <span className="relative inline-flex" style={box} aria-hidden>
          <svg viewBox="0 0 16 16" width={size} height={size} className="animate-sweep">
            <circle cx="8" cy="8" r="6" fill="none" stroke={style.color} strokeOpacity="0.25" strokeWidth="3" />
            <path
              d="M8 2a6 6 0 0 1 6 6"
              fill="none"
              stroke={style.color}
              strokeWidth="3"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );

    case 'triangle':
      return (
        <svg viewBox="0 0 16 16" width={size + 2} height={size + 2} aria-hidden>
          <path
            d="M8 2.5 14.5 13.5H1.5z"
            fill={`color-mix(in oklab, ${style.color} 22%, transparent)`}
            stroke={style.color}
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      );

    case 'cross':
      return (
        <svg viewBox="0 0 16 16" width={size + 2} height={size + 2} aria-hidden>
          <circle cx="8" cy="8" r="6.6" fill={`color-mix(in oklab, ${style.color} 18%, transparent)`} />
          <path
            d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6"
            stroke={style.color}
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );

    case 'question':
    default:
      return (
        <span
          className="inline-block rounded-full border-2 border-dashed animate-shimmer"
          style={{ ...box, borderColor: style.color }}
          aria-hidden
        />
      );
  }
}

export function StatusBadge({
  state,
  className,
  label,
}: {
  state: ServiceState;
  className?: string;
  label?: string;
}) {
  const style = stateStyle(state);
  return (
    <span
      title={style.hint}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11px] font-medium tracking-wide',
        style.chip,
        className,
      )}
    >
      <StatusIndicator state={state} size={9} />
      {label ?? style.label}
    </span>
  );
}

/** Thin horizontal bar showing how the fleet is distributed across states. */
export function StateDistribution({
  counts,
  total,
  className,
}: {
  counts: Map<string, number>;
  total: number;
  className?: string;
}) {
  const order: ServiceState[] = ['running', 'degraded', 'failed', 'starting', 'stopping', 'stopped', 'unknown'];
  return (
    <div className={clsx('flex h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)}>
      {order.map((state) => {
        const count = counts.get(state) ?? 0;
        if (count === 0) return null;
        const style = stateStyle(state);
        return (
          <span
            key={state}
            title={`${count} ${style.label.toLowerCase()}`}
            style={{ width: `${(count / Math.max(total, 1)) * 100}%`, background: style.color }}
            className="h-full transition-[width] duration-500"
          />
        );
      })}
    </div>
  );
}
