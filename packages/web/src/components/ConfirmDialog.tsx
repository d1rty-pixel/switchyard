import { AlertTriangle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

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
  const destructive = request?.destructive ?? false;

  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && onCancel()}>
      {request && (
        <AlertDialogContent
          // The width has to be stated on the same `data-[size]` variant
          // AlertDialogContent uses, or its own `sm:max-w-sm` is never
          // displaced — and a command line needs the room.
          className="glass card-sheen data-[size=default]:max-w-md data-[size=default]:sm:max-w-md"
        >
          <AlertDialogHeader>
            <AlertDialogMedia
              className={cn(
                'border bg-transparent',
                destructive
                  ? 'border-st-failed/30 bg-st-failed/10 text-st-failed'
                  : 'border-signal/30 bg-signal/10 text-signal',
              )}
            >
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle className="text-ink">{request.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-ink-2">{request.body}</AlertDialogDescription>
            {request.detail && (
              <pre className="mono col-start-1 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-line bg-base/60 p-2 text-left text-faint sm:col-start-2">
                {request.detail}
              </pre>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className="border-line bg-base/40">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              autoFocus
              onClick={onConfirm}
              className={cn(
                'border font-semibold',
                destructive
                  ? 'border-st-failed/40 bg-st-failed/15 text-st-failed hover:bg-st-failed/25'
                  : 'border-signal/40 bg-signal/15 text-signal hover:bg-signal/25',
              )}
            >
              {request.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
