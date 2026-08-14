import { cn } from '@/lib/utils';
import { toneStyle } from '@/lib/status';
import type { MetricTone } from '@/lib/types';

/**
 * A bordered, tinted line of prose: config warnings, provider warnings, alert
 * rows, inline errors. Every one of these was written out by hand with its own
 * border/background/text triple; they are one shape with a tone, and getting
 * that tone from `toneStyle` is what keeps a warning the same colour wherever
 * it turns up.
 */
export function Callout({
  tone = 'warn',
  icon: Icon,
  as: Element = 'div',
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  tone?: MetricTone;
  icon?: React.ComponentType<{ className?: string }>;
  /** `li` inside a list, `button` where the whole callout opens something. */
  as?: 'div' | 'li' | 'button';
}) {
  return (
    <Element
      className={cn(
        'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-[13px] leading-relaxed',
        toneStyle(tone).chip,
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="mt-0.5 size-3.5 shrink-0" />}
      <span className="min-w-0 break-words">{children}</span>
    </Element>
  );
}
