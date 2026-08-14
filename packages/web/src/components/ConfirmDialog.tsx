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
          className="data-[size=default]:max-w-md data-[size=default]:sm:max-w-md"
        >
          <AlertDialogHeader>
            <AlertDialogMedia
              className={cn(
                'border bg-transparent',
                destructive
                  ? 'border-red-500/30 bg-red-500/10 text-red-500'
                  : 'border-primary/30 bg-primary/10 text-primary',
              )}
            >
              <AlertTriangle />
            </AlertDialogMedia>
            <AlertDialogTitle className="text-foreground">{request.title}</AlertDialogTitle>
            {/* Bodies carry file paths, which have no break opportunities of
                their own and would otherwise push the dialog wider. */}
            <AlertDialogDescription className="w-full wrap-anywhere text-muted-foreground">
              {request.body}
            </AlertDialogDescription>
            {request.detail && (
              <pre className="font-mono col-start-1 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-muted p-2 text-left text-muted-foreground sm:col-start-2">
                {request.detail}
              </pre>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter className="border-border bg-muted/40">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              autoFocus
              onClick={onConfirm}
              className={cn(
                'border font-semibold',
                destructive
                  ? 'border-red-500/40 bg-red-500/15 text-red-500 hover:bg-red-500/25'
                  : 'border-primary/40 bg-primary/15 text-primary hover:bg-primary/25',
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
