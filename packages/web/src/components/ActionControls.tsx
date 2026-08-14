import { Loader2, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { actionIcon } from '@/lib/icons';
import type { ActionDescriptor, ServiceSummary } from '@/lib/types';

const KIND_CLASS: Record<ActionDescriptor['kind'], string> = {
  primary: 'bg-primary/15 text-primary border-primary/30 hover:bg-primary/25 hover:border-primary/50',
  secondary: 'bg-popover text-muted-foreground border-border hover:bg-secondary hover:text-foreground',
  danger: 'bg-red-500/10 text-red-500 border-red-500/30 hover:bg-red-500/20 hover:border-red-500/50',
  utility: 'bg-transparent text-muted-foreground border-border hover:bg-popover hover:text-muted-foreground',
};

export interface ActionButtonProps {
  action: ActionDescriptor;
  running: boolean;
  disabled: boolean;
  disabledReason?: string;
  onRun: () => void;
  /** Tighter padding — used by the table view's rows. */
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
    <Button
      variant="outline"
      size={compact ? 'xs' : 'sm'}
      onClick={onRun}
      disabled={disabled || running}
      title={disabled ? disabledReason ?? action.description : action.description}
      className={cn(
        'rounded-lg border',
        compact ? 'text-[12px]' : 'text-[13px]',
        KIND_CLASS[action.kind],
        (disabled || running) && 'pointer-events-none opacity-40 shadow-none',
      )}
    >
      {running ? <Loader2 className="animate-spin" /> : Icon ? <Icon /> : null}
      {action.label}
    </Button>
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
  /**
   * Sort the actions that apply to the current state to the front, so the few
   * inline slots hold usable buttons rather than greyed-out ones. Worth it
   * where the slots are scarce (the table's single slot shows "Start" for a
   * running service otherwise) and not where they are not: on a card the full
   * set is visible anyway, and buttons that stay put are easier to aim at.
   */
  prioritiseEnabled?: boolean;
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
  prioritiseEnabled = false,
}: ActionRowProps) {
  const busy = service.busy ?? null;
  const applies = (action: ActionDescriptor) => !action.enabledIn || action.enabledIn.includes(service.state);
  const matching = service.actions.filter((action) => inlineKinds.includes(action.kind));
  // Stable sort, so actions that apply keep their configured order among
  // themselves and merely move ahead of the ones that do not. While an action
  // runs everything is locked anyway, and reordering under the pointer would be
  // worse than a stale order.
  const candidates =
    prioritiseEnabled && !busy
      ? [...matching].sort((a, b) => Number(applies(b)) - Number(applies(a)))
      : matching;
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
    if (!applies(action)) return `Only available while ${action.enabledIn!.join(', ')}`;
    return undefined;
  };

  return (
    <div className={cn('flex items-center gap-1.5', wrap ? 'flex-wrap' : 'flex-nowrap')}>
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

/**
 * Overflow actions. The menu is portalled and collision-aware, which is what
 * this needs: an absolutely positioned panel inside a card is a sibling of the
 * other cards in the grid, so a later card paints over it, and it cannot flip
 * above the trigger for a card near the bottom of the viewport.
 */
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="More actions"
          className="rounded-lg border-border bg-transparent text-muted-foreground hover:bg-popover hover:text-foreground"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(20rem,60vh)] w-[15.5rem] overflow-y-auto"
      >
        {actions.map((action) => {
          const Icon = actionIcon(action.icon);
          const reason = reasonFor(action);
          const locked = disabled || reason !== undefined;
          return (
            <DropdownMenuItem
              key={action.id}
              disabled={locked}
              title={reason ?? action.description}
              onSelect={() => onRun(action)}
              className="gap-2.5 py-2"
            >
              {busyActionId === action.id ? (
                <Loader2 className="animate-spin text-primary" />
              ) : Icon ? (
                <Icon className="text-muted-foreground" />
              ) : (
                <span className="size-3.5" />
              )}
              <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{action.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
