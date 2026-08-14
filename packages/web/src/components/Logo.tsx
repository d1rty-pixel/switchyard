import { cn } from '@/lib/utils';

/**
 * Switchyard mark: one incoming path splitting at a junction node into two
 * outgoing routes. Signal teal for the active route, indigo for the alternate.
 * The junction dot is the only filled element, so it reads as a control point.
 */
export function Logo({ className, animated = true }: { className?: string; animated?: boolean }) {
  return (
    <svg viewBox="0 0 40 40" className={cn('shrink-0', className)} role="img" aria-label="Switchyard">
      <defs>
        <linearGradient id="sy-plate" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#131c26" />
          <stop offset="100%" stopColor="#0a1016" />
        </linearGradient>
        <linearGradient id="sy-signal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-signal-dim)" />
          <stop offset="100%" stopColor="var(--color-signal)" />
        </linearGradient>
        <linearGradient id="sy-route" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-route-dim)" />
          <stop offset="100%" stopColor="var(--color-route)" />
        </linearGradient>
      </defs>

      <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="10" fill="url(#sy-plate)" />
      <rect
        x="0.75"
        y="0.75"
        width="38.5"
        height="38.5"
        rx="10"
        fill="none"
        stroke="var(--color-line)"
        strokeWidth="1.5"
      />

      {/* Incoming trunk */}
      <path d="M6 20h9" stroke="url(#sy-signal)" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      {/* Primary route, upward */}
      <path
        d="M15 20l7-7h12"
        stroke="url(#sy-signal)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Alternate route, downward */}
      <path
        d="M15 20l7 7h12"
        stroke="url(#sy-route)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity="0.85"
      />
      {/* Travelling signal along the primary route */}
      {animated && (
        <path
          d="M15 20l7-7h12"
          stroke="var(--color-signal)"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
          strokeDasharray="3 19"
          className="animate-track"
          opacity="0.95"
        />
      )}

      {/* Junction */}
      <circle cx="15" cy="20" r="3.6" fill="#080c11" stroke="var(--color-signal)" strokeWidth="2.4" />
      <circle cx="15" cy="20" r="1.1" fill="var(--color-signal)" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight text-ink', className)}>
      Switch<span className="text-signal">yard</span>
    </span>
  );
}
