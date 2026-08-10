import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, MoreHorizontal } from 'lucide-react';
import clsx from 'clsx';
import { actionIcon } from '../lib/icons';
import type { ActionDescriptor, ServiceSummary } from '../lib/types';

const KIND_CLASS: Record<ActionDescriptor['kind'], string> = {
  primary:
    'bg-signal/15 text-signal border-signal/30 hover:bg-signal/25 hover:border-signal/50 shadow-[0_0_18px_-8px_var(--color-signal)]',
  secondary: 'bg-surface-2 text-ink-2 border-line hover:bg-surface-3 hover:text-ink',
  danger: 'bg-st-failed/10 text-st-failed border-st-failed/30 hover:bg-st-failed/20 hover:border-st-failed/50',
  utility: 'bg-transparent text-muted border-line-soft hover:bg-surface-2 hover:text-ink-2',
};

export interface ActionButtonProps {
  action: ActionDescriptor;
  running: boolean;
  disabled: boolean;
  disabledReason?: string;
  onRun: () => void;
  /** Tighter padding and no "slow" hint — used by the table view's rows. */
  compact?: boolean;
}

export function ActionButton({
  action,
  running,
  disabled,
  disabledReason,
  onRun,
  compact = false,
}: ActionButtonProps) {
  const Icon = actionIcon(action.icon);
  return (
    <button
      type="button"
      onClick={onRun}
      disabled={disabled || running}
      title={disabled ? disabledReason ?? action.description : action.description}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-lg border font-medium transition-all duration-150',
        compact ? 'px-2 py-1 text-[12px]' : 'px-2.5 py-1.5 text-[13px]',
        KIND_CLASS[action.kind],
        (disabled || running) && 'pointer-events-none opacity-40 shadow-none',
      )}
    >
      {running ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : Icon ? (
        <Icon className="size-3.5" />
      ) : null}
      {action.label}
      {action.slow && !running && !compact && (
        <span className="text-[10px] uppercase tracking-wider opacity-60">slow</span>
      )}
    </button>
  );
}

export interface ActionRowProps {
  service: ServiceSummary;
  /** Actions rendered inline; the rest move into the overflow menu. */
  inlineKinds?: ActionDescriptor['kind'][];
  /** Hard cap on inline buttons so a card footer never wraps. */
  inlineLimit?: number;
  onRun: (action: ActionDescriptor) => void;
  compact?: boolean;
  /** False keeps the row on one line — table cells size to their content. */
  wrap?: boolean;
}

/**
 * Renders a service's action set. All controls lock while any action runs on
 * that service, which is exactly the constraint the backend enforces (409 on a
 * second concurrent action) — the UI just makes it visible.
 */
export function ActionRow({
  service,
  inlineKinds = ['primary', 'secondary', 'danger'],
  inlineLimit = 3,
  onRun,
  compact,
  wrap = true,
}: ActionRowProps) {
  const busy = service.busy ?? null;
  const candidates = service.actions.filter((action) => inlineKinds.includes(action.kind));
  // The overflow trigger occupies a slot of its own, so give up one inline
  // button whenever it will be rendered — otherwise the footer wraps to a
  // second line just to hold a lone "…".
  const willOverflow =
    candidates.length > inlineLimit || service.actions.some((action) => !inlineKinds.includes(action.kind));
  const effectiveLimit = willOverflow ? Math.max(1, inlineLimit - 1) : inlineLimit;
  // Keep a running action visible inline even if it sits past the cut-off.
  const inline = candidates
    .slice(0, effectiveLimit)
    .concat(
      busy && candidates.slice(effectiveLimit).some((action) => action.id === busy.actionId)
        ? candidates.filter((action) => action.id === busy.actionId)
        : [],
    );
  const inlineIds = new Set(inline.map((action) => action.id));
  const overflow = service.actions.filter((action) => !inlineIds.has(action.id));

  const reasonFor = (action: ActionDescriptor): string | undefined => {
    if (busy) return `${busy.label} is running`;
    if (action.enabledIn && !action.enabledIn.includes(service.state)) {
      return `Only available while ${action.enabledIn.join(', ')}`;
    }
    return undefined;
  };

  return (
    <div className={clsx('flex items-center gap-1.5', wrap ? 'flex-wrap' : 'flex-nowrap')}>
      {inline.map((action) => {
        const reason = reasonFor(action);
        return (
          <ActionButton
            key={action.id}
            action={action}
            running={busy?.actionId === action.id}
            disabled={reason !== undefined}
            disabledReason={reason}
            onRun={() => onRun(action)}
            compact={compact}
          />
        );
      })}
      {overflow.length > 0 && (
        <OverflowMenu
          actions={overflow}
          busyActionId={busy?.actionId}
          disabled={busy !== null}
          reasonFor={reasonFor}
          onRun={onRun}
        />
      )}
    </div>
  );
}

/** Menu width; also used to keep the panel inside the viewport. */
const MENU_WIDTH = 248;

function OverflowMenu({
  actions,
  busyActionId,
  disabled,
  reasonFor,
  onRun,
}: {
  actions: ActionDescriptor[];
  busyActionId?: string;
  disabled: boolean;
  reasonFor: (action: ActionDescriptor) => string | undefined;
  onRun: (action: ActionDescriptor) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number; placement: 'up' | 'down' } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  /*
   * The menu is rendered into document.body with fixed positioning. Absolutely
   * positioning it inside the card makes it a sibling of the other cards in the
   * grid, where a later card paints on top of it, and it cannot flip above the
   * trigger when the card sits near the bottom of the viewport. A portal solves
   * both, at the cost of positioning it by hand.
   */
  const place = useCallback(() => {
    const button = trigger.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const estimatedHeight = Math.min(actions.length * 46 + 8, 320);
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement: 'up' | 'down' = spaceBelow < estimatedHeight + 12 ? 'up' : 'down';
    const left = Math.min(
      Math.max(8, rect.right - MENU_WIDTH),
      Math.max(8, window.innerWidth - MENU_WIDTH - 8),
    );
    setAnchor({
      top: placement === 'down' ? rect.bottom + 6 : Math.max(8, rect.top - estimatedHeight - 6),
      left,
      placement,
    });
  }, [actions.length]);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    place();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (container.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Reposition rather than float away when the page moves underneath.
    const onViewportChange = () => place();

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, place]);

  return (
    <div className="relative" ref={container}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="More actions"
        aria-expanded={open}
        className={clsx(
          'inline-flex items-center gap-1 rounded-lg border border-line-soft px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-surface-2 hover:text-ink',
          open && 'bg-surface-2 text-ink',
        )}
      >
        <MoreHorizontal className="size-3.5" />
      </button>

      {open && anchor && createPortal(
        <>
          <div
            ref={panel}
            style={{ position: 'fixed', top: anchor.top, left: anchor.left, width: MENU_WIDTH }}
            // Nearly opaque: this floats over other cards, so the text behind it
            // must not bleed through.
            className="glass animate-pop-in z-[70] max-h-[min(20rem,60vh)] overflow-y-auto rounded-xl bg-surface-2/97 p-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.95)]"
          >
            {actions.map((action) => {
              const Icon = actionIcon(action.icon);
              const reason = reasonFor(action);
              const locked = disabled || reason !== undefined;
              return (
                <button
                  key={action.id}
                  type="button"
                  disabled={locked}
                  title={reason ?? action.description}
                  onClick={() => {
                    setOpen(false);
                    onRun(action);
                  }}
                  className={clsx(
                    'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                    locked ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-2',
                  )}
                >
                  {busyActionId === action.id ? (
                    <Loader2 className="mt-0.5 size-3.5 animate-spin text-signal" />
                  ) : Icon ? (
                    <Icon className="mt-0.5 size-3.5 text-muted" />
                  ) : (
                    <span className="mt-0.5 size-3.5" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{action.label}</span>
                    {action.description && (
                      <span className="mono block truncate text-faint">{action.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
