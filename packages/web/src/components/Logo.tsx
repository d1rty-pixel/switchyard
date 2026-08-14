import { cn } from '@/lib/utils';

// Brand colours for the mark itself — fixed, not theme tokens, so the logo
// keeps its identity regardless of light/dark mode or theme accent.
const BRAND_TEAL = '#2ee6c5';
const BRAND_INDIGO = '#7c8cff';

/**
 * Switchyard mark: one incoming path splitting at a junction node into two
 * outgoing routes. Teal for the primary route, indigo for the alternate.
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
      </defs>

      <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="10" fill="url(#sy-plate)" />
      <rect x="0.75" y="0.75" width="38.5" height="38.5" rx="10" fill="none" stroke="#232f3d" strokeWidth="1.5" />

      {/* Incoming trunk */}
      <path d="M6 20h9" stroke={BRAND_TEAL} strokeWidth="2.6" strokeLinecap="round" fill="none" />
      {/* Primary route, upward */}
      <path
        d="M15 20l7-7h12"
        stroke={BRAND_TEAL}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* Alternate route, downward */}
      <path
        d="M15 20l7 7h12"
        stroke={BRAND_INDIGO}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity="0.85"
      />
      {/* Travelling pip along the primary route */}
      {animated && (
        <path
          d="M15 20l7-7h12"
          stroke={BRAND_TEAL}
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
          strokeDasharray="3 19"
          className="animate-pulse"
          opacity="0.95"
        />
      )}

      {/* Junction */}
      <circle cx="15" cy="20" r="3.6" fill="#080c11" stroke={BRAND_TEAL} strokeWidth="2.4" />
      <circle cx="15" cy="20" r="1.1" fill={BRAND_TEAL} />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-semibold tracking-tight text-foreground', className)}>
      Switch<span style={{ color: BRAND_TEAL }}>yard</span>
    </span>
  );
}
