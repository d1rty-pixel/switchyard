import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, Info, X } from 'lucide-react';
import clsx from 'clsx';

export type ToastTone = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  /** Collapsed command output; only rendered when the user expands it. */
  details?: string;
}

interface ToastApi {
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS: Record<ToastTone, number | null> = {
  success: 5_000,
  info: 6_000,
  // Failures stay until dismissed: they usually carry output worth reading.
  error: null,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current.slice(-4), { ...toast, id }]);
      const timeout = AUTO_DISMISS_MS[toast.tone];
      if (timeout) setTimeout(() => dismiss(id), timeout);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0 sm:w-[26rem]">
        {/* Toasts unmount the moment they leave state — see ServiceDrawer. */}
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToasts must be used inside ToastProvider');
  return context;
}

const TONE_STYLE: Record<ToastTone, { ring: string; icon: ReactNode; accent: string }> = {
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
  info: {
    ring: 'border-route/35',
    accent: 'bg-route',
    icon: <Info className="size-4 text-route" />,
  },
};

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const tone = TONE_STYLE[toast.tone];

  return (
    <div
      className={clsx(
        'glass animate-toast-in pointer-events-auto relative w-full overflow-hidden rounded-xl shadow-[0_18px_40px_-18px_rgba(0,0,0,0.9)]',
        tone.ring,
      )}
    >
      <div className={clsx('absolute inset-y-0 left-0 w-[3px]', tone.accent)} />
      <div className="flex items-start gap-3 p-3 pl-4">
        <div className="mt-0.5 shrink-0">{tone.icon}</div>
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-medium text-ink">{toast.title}</p>
          {toast.message && <p className="mt-0.5 break-words text-[13px] leading-relaxed text-ink-2">{toast.message}</p>}
          {toast.details && (
            <>
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-muted transition-colors hover:text-signal"
              >
                <ChevronDown className={clsx('size-3 transition-transform', expanded && 'rotate-180')} />
                {expanded ? 'Hide output' : 'Show output'}
              </button>
              {expanded && (
                <pre className="mono animate-fade-in mt-2 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/70 p-2 text-faint">
                  {toast.details}
                </pre>
              )}
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="rounded-md p-1 text-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
