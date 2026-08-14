import { useState } from 'react';
import { AlertTriangle, ChevronRight, FileWarning, MonitorX, PowerOff, SearchX, Unplug, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Callout } from './Callout';
import { Logo } from './Logo';
import type { DisabledService } from '@/lib/types';

/** No services in the config file at all. */
export function NoServicesState({ configPath }: { configPath?: string }) {
  return (
    <Shell
      icon={<Logo className="size-12" animated={false} />}
      title="No services configured yet"
      body="Switchyard reads one file per service from services.d/. Drop a file in, hit Reload config — no restart needed."
    >
      {configPath && (
        <p className="font-mono mt-1 text-muted-foreground">
          config: <span className="text-muted-foreground">{configPath}</span>
        </p>
      )}
      <pre className="font-mono mt-4 w-full max-w-lg overflow-x-auto rounded-xl border border-border bg-muted p-3 text-left text-muted-foreground">
{`# services.d/my-worker.yaml
id: my-worker
name: My worker
type: command
group: development
enabled: true
provider:
  status:
    run: [/opt/my-worker/ctl.sh, status]
  actions:
    - id: start
      label: Start
      kind: primary
      run: [/opt/my-worker/ctl.sh, start]`}
      </pre>
    </Shell>
  );
}

/** Filters or search eliminated every card. */
export function NoMatchesState({ onClear }: { onClear: () => void }) {
  return (
    <Shell
      icon={<SearchX className="size-8 text-muted-foreground" />}
      title="Nothing matches these filters"
      body="Try a different search term, or clear the active filters."
    >
      <SignalButton className="mt-4" onClick={onClear}>
        Clear filters
      </SignalButton>
    </Shell>
  );
}

/** The API is unreachable — usually the server is not running. */
export function ApiDownState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Shell
      icon={<Unplug className="size-8 text-red-500" />}
      title="Cannot reach the Switchyard API"
      body="The dashboard is loaded, but the backend did not answer."
    >
      <p className="font-mono mt-1 max-w-lg break-words text-red-500/80">{message}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <SignalButton onClick={onRetry}>Retry</SignalButton>
        <code className="font-mono rounded-lg border border-border bg-muted px-2.5 py-1.5 text-muted-foreground">npm start</code>
      </div>
    </Shell>
  );
}

/** Config-level warnings from the server (missing workdirs, undeclared groups). */
export function ConfigWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Banner>
      <Callout tone="warn" icon={FileWarning} className="px-3 py-2.5 text-[13.5px]">
        <span className="font-medium">
          {warnings.length === 1 ? 'Configuration warning' : `${warnings.length} configuration warnings`}
        </span>
        <ul className="mt-1 space-y-0.5">
          {warnings.map((warning) => (
            <li key={warning} className="font-mono break-words text-amber-500/80">
              {warning}
            </li>
          ))}
        </ul>
      </Callout>
    </Banner>
  );
}

/**
 * No GPU compositor available (accel disabled, or a software renderer).
 * Heavier visual effects degrade to cheaper ones in that case — see
 * `hasGpuAcceleration` — so this just tells the user why the UI looks a
 * little plainer than usual. Dismiss is remembered per browser.
 */
export function GpuAccelWarning({ dismissed, onDismiss }: { dismissed: boolean; onDismiss: () => void }) {
  if (dismissed) return null;
  return (
    <Banner>
      <Callout tone="warn" icon={MonitorX} className="items-center px-3 py-2.5 text-[13.5px]">
        <span className="flex items-center gap-2">
          <span className="flex-1">
            GPU acceleration is off in this browser. Some visual effects are toned down so the UI stays smooth.
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onDismiss}
            aria-label="Dismiss"
            className="shrink-0 text-amber-500/70 hover:bg-amber-500/10 hover:text-amber-500"
          >
            <X />
          </Button>
        </span>
      </Callout>
    </Banner>
  );
}

/**
 * Definitions switched off with `enabled: false`. They are not polled and have
 * no actions, but they should not vanish silently either — the whole point of
 * the flag is that you can find them again.
 */
export function DisabledServices({
  services,
  providers,
}: {
  services: DisabledService[];
  providers: { type: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  if (services.length === 0) return null;

  const providerLabel = new Map(providers.map((provider) => [provider.type, provider.label]));

  return (
    <div className="mx-auto mt-8 max-w-[110rem] px-4 sm:px-6">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="rounded-lg border-border bg-card/40 text-[12.5px] text-muted-foreground hover:text-foreground"
      >
        <PowerOff />
        {services.length} disabled {services.length === 1 ? 'service' : 'services'}
        <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
      </Button>

      {open && (
        <ul className="animate-in fade-in slide-in-from-bottom-1 mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <li
              key={service.id}
              className="flex items-center gap-2 rounded-lg border border-border border-dashed bg-card/30 px-2.5 py-2"
            >
              <PowerOff className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">{service.name}</span>
              <span className="shrink-0 rounded border border-border bg-popover/60 px-1.5 py-px text-[11px] font-medium text-muted-foreground">
                {providerLabel.get(service.type) ?? service.type}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <Banner>
      <Callout tone="bad" icon={AlertTriangle} className="px-3 py-2.5 text-[13.5px]">
        {message}
      </Callout>
    </Banner>
  );
}

/** Full-width strip above the service list, where every banner sits. */
function Banner({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto mb-4 max-w-[110rem] px-4 sm:px-6">{children}</div>;
}

/** The one call-to-action style the empty states use. */
function SignalButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      className={cn(
        'rounded-lg border-primary/35 bg-primary/12 text-[13px] font-medium text-primary hover:bg-primary/20 hover:text-primary',
        className,
      )}
      {...props}
    />
  );
}

function Shell({
  icon,
  title,
  body,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-1 flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-4 grid place-items-center">{icon}</div>
      <h2 className="text-[16px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-md text-[14px] leading-relaxed text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}
