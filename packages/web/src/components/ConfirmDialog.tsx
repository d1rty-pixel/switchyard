import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import clsx from 'clsx';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  destructive?: boolean;
  /** Extra line shown in monospace, e.g. the command the provider will run. */
  detail?: string;
}

export function ConfirmDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ConfirmRequest | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
      if (event.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onCancel, onConfirm]);

  // Unmounts immediately on cancel/confirm. A modal that lingers would keep a
  // full-viewport backdrop over the dashboard — see the note in ServiceDrawer.
  if (!request) return null;

  return (
    <>
      {
        <div className="animate-fade-in fixed inset-0 z-[60] grid place-items-center p-4">
          <div className="absolute inset-0 bg-base/70 backdrop-blur-sm" onClick={onCancel} />
          <div
            className="glass animate-pop-in relative w-full max-w-md overflow-hidden rounded-2xl shadow-[0_30px_80px_-30px_rgba(0,0,0,1)]"
            role="dialog"
            aria-modal="true"
          >
            <div
              className={clsx(
                'absolute inset-x-0 top-0 h-px',
                request.destructive ? 'bg-st-failed/60' : 'bg-signal/50',
              )}
            />
            <div className="flex gap-3.5 p-5">
              <div
                className={clsx(
                  'mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl border',
                  request.destructive
                    ? 'border-st-failed/30 bg-st-failed/10 text-st-failed'
                    : 'border-signal/30 bg-signal/10 text-signal',
                )}
              >
                <AlertTriangle className="size-4.5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[16px] font-semibold text-ink">{request.title}</h2>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{request.body}</p>
                {request.detail && (
                  <pre className="mono mt-2.5 overflow-x-auto rounded-lg border border-line bg-base/60 p-2 text-faint">
                    {request.detail}
                  </pre>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-line bg-base/40 px-4 py-3">
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-line px-3 py-1.5 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                autoFocus
                className={clsx(
                  'rounded-lg border px-3 py-1.5 text-[13px] font-semibold transition-colors',
                  request.destructive
                    ? 'border-st-failed/40 bg-st-failed/15 text-st-failed hover:bg-st-failed/25'
                    : 'border-signal/40 bg-signal/15 text-signal hover:bg-signal/25',
                )}
              >
                {request.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      }
    </>
  );
}
