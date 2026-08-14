import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Info, X } from 'lucide-react';
import { toast as sonner } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  tone: ToastTone;
  title: string;
  message?: string;
  /** Collapsed command output; only rendered when the user expands it. */
  details?: string;
}

const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  success: 5_000,
  info: 6_000,
  // A resource warning describes a condition that is still going on, so it is
  // given longer than an informational message but does not demand a click.
  warning: 12_000,
  // Failures stay until dismissed: they usually carry output worth reading.
  error: null,
};

const TONE_STYLE: Record<ToastTone, { ring: string; accent: string; icon: React.ReactNode }> = {
  success: {
    ring: 'border-st-running/35',
    accent: 'bg-st-running',
    icon: <Check className="size-4 text-st-running" />,
  },
  error: {
    ring: 'border-st-failed/40',
    accent: 'bg-st-failed',
    icon: <AlertTriangle className="size-4 text-st-failed" />,
  },
  warning: {
    ring: 'border-st-degraded/40',
    accent: 'bg-st-degraded',
    icon: <AlertTriangle className="size-4 text-st-degraded" />,
  },
  info: {
    ring: 'border-route/35',
    accent: 'bg-route',
    icon: <Info className="size-4 text-route" />,
  },
};

/**
 * Sonner owns the stack, the timers and dismissal. The card below stays ours:
 * a toast here can carry collapsed command output, which no stock toast body
 * renders.
 */
export function ToastViewport() {
  return (
    <Toaster
      position="bottom-right"
      offset={16}
      // `unstyled` also drops sonner's width, so the card below sets its own.
      toastOptions={{ unstyled: true }}
    />
  );
}

export function useToasts() {
  return useMemo(
    () => ({
      push: (toast: Toast) => {
        sonner.custom((id) => <ToastCard toast={toast} onDismiss={() => sonner.dismiss(id)} />, {
          duration: AUTO_DISMISS_MS[toast.tone] ?? Infinity,
        });
      },
      dismiss: (id: string | number) => sonner.dismiss(id),
    }),
    [],
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const tone = TONE_STYLE[toast.tone];

  return (
    <div
      className={cn(
        'glass pointer-events-auto relative w-[26rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)]',
        tone.ring,
      )}
    >
      <div className={cn('absolute inset-y-0 left-0 w-[3px]', tone.accent)} />
      <div className="flex items-start gap-3 p-3 pl-4">
        <div className="mt-0.5 shrink-0">{tone.icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink">{toast.title}</p>
          {toast.message && <p className="mt-0.5 break-words text-[13px] leading-relaxed text-ink-2">{toast.message}</p>}
          {toast.details && (
            <>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setExpanded((value) => !value)}
                className="mt-1.5 -ml-1 text-[12px] text-ink-3 hover:bg-transparent hover:text-signal"
              >
                <ChevronDown className={cn('transition-transform', expanded && 'rotate-180')} />
                {expanded ? 'Hide output' : 'Show output'}
              </Button>
              {expanded && (
                <pre className="mono animate-fade-in mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/70 p-2 text-faint">
                  {toast.details}
                </pre>
              )}
            </>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="text-faint hover:text-ink"
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
