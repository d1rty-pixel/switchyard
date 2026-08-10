import { useState } from 'react';
import { AlertTriangle, ChevronRight, FileWarning, PowerOff, SearchX, Unplug } from 'lucide-react';
import clsx from 'clsx';
import { Logo } from './Logo';
import type { DisabledService } from '../lib/types';

/** No services in the config file at all. */
export function NoServicesState({ configPath }: { configPath?: string }) {
  return (
    <Shell
      icon={<Logo className="size-12" animated={false} />}
      title="No services configured yet"
      body="Switchyard reads one file per service from services.d/. Drop a file in, hit Reload config — no restart needed."
    >
      {configPath && (
        <p className="mono mt-1 text-faint">
          config: <span className="text-ink-2">{configPath}</span>
        </p>
      )}
      <pre className="mono mt-4 w-full max-w-lg overflow-x-auto rounded-xl border border-line bg-base/60 p-3 text-left text-ink-2">
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
      icon={<SearchX className="size-8 text-faint" />}
      title="Nothing matches these filters"
      body="Try a different search term, or clear the active filters."
    >
      <button
        type="button"
        onClick={onClear}
        className="mt-4 rounded-lg border border-signal/35 bg-signal/12 px-3 py-1.5 text-[13px] font-medium text-signal transition-colors hover:bg-signal/20"
      >
        Clear filters
      </button>
    </Shell>
  );
}

/** The API is unreachable — usually the server is not running. */
export function ApiDownState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Shell
      icon={<Unplug className="size-8 text-st-failed" />}
      title="Cannot reach the Switchyard API"
      body="The dashboard is loaded, but the backend did not answer."
    >
      <p className="mono mt-1 max-w-lg break-words text-st-failed/80">{message}</p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg border border-signal/35 bg-signal/12 px-3 py-1.5 text-[13px] font-medium text-signal transition-colors hover:bg-signal/20"
        >
          Retry
        </button>
        <code className="mono rounded-lg border border-line bg-base/60 px-2.5 py-1.5 text-faint">npm start</code>
      </div>
    </Shell>
  );
}

/** Config-level warnings from the server (missing workdirs, undeclared groups). */
export function ConfigWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mx-auto mb-4 max-w-[110rem] px-4 sm:px-6">
      <div className="flex items-start gap-2.5 rounded-xl border border-st-degraded/25 bg-st-degraded/[0.06] px-3 py-2.5">
        <FileWarning className="mt-0.5 size-4 shrink-0 text-st-degraded" />
        <div className="min-w-0">
          <p className="text-[13.5px] font-medium text-st-degraded">
            {warnings.length === 1 ? 'Configuration warning' : `${warnings.length} configuration warnings`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {warnings.map((warning) => (
              <li key={warning} className="mono break-words text-st-degraded/80">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Definitions switched off with `enabled: false`. They are not polled and have
 * no actions, but they should not vanish silently either — the whole point of
 * the flag is that you can find them again.
 */
export function DisabledServices({ services }: { services: DisabledService[] }) {
  const [open, setOpen] = useState(false);
  if (services.length === 0) return null;

  return (
    <div className="mx-auto mt-8 max-w-[110rem] px-4 sm:px-6">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface/40 px-2.5 py-1.5 text-[12.5px] text-muted transition-colors hover:text-ink"
      >
        <PowerOff className="size-3.5" />
        {services.length} disabled {services.length === 1 ? 'service' : 'services'}
        <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>

      {open && (
        <ul className="animate-rise mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <li
              key={service.id}
              className="flex items-center gap-2 rounded-lg border border-line-soft border-dashed bg-surface/30 px-2.5 py-2"
            >
              <PowerOff className="size-3.5 shrink-0 text-faint" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] text-ink-2">{service.name}</span>
                <span className="mono block truncate text-faint" title={service.source}>
                  {service.type} · {service.source.split('/').pop()}
                </span>
              </span>
              <span className="shrink-0 rounded border border-line-soft px-1.5 py-px text-[11px] text-faint">
                enabled: false
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
    <div className="mx-auto mb-4 flex max-w-[110rem] items-start gap-2 px-4 sm:px-6">
      <div className="flex w-full items-start gap-2.5 rounded-xl border border-st-failed/25 bg-st-failed/[0.06] px-3 py-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-st-failed" />
        <p className="min-w-0 break-words text-[13.5px] text-st-failed">{message}</p>
      </div>
    </div>
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
    <div className="animate-rise flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-4 grid place-items-center">{icon}</div>
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 max-w-md text-[14px] leading-relaxed text-ink-2">{body}</p>
      {children}
    </div>
  );
}
