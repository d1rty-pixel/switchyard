import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Boxes,
  Clock3,
  FolderOpen,
  History,
  Info,
  Loader2,
  RefreshCw,
  Radio,
  ScrollText,
  Settings2,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useRefreshService, useServiceDetail } from '../lib/hooks';
import { formatAgo, formatClock, formatDuration, formatMetric, formatUptime } from '../lib/format';
import { iconFor } from '../lib/icons';
import { stateStyle } from '../lib/status';
import { StatusBadge, StatusIndicator } from './StatusIndicator';
import { ActionRow } from './ActionControls';
import { LogPane } from './LogPane';
import type { ActionDescriptor, ChildStatus, ServiceDetail, ServiceSummary } from '../lib/types';

type Tab = 'overview' | 'logs' | 'history' | 'config';

export function ServiceDrawer({
  serviceId,
  onClose,
  onRunAction,
}: {
  serviceId: string | null;
  onClose: () => void;
  onRunAction: (service: ServiceSummary, action: ActionDescriptor) => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const detail = useServiceDetail(serviceId);
  const refresh = useRefreshService();

  useEffect(() => setTab('overview'), [serviceId]);

  const service = detail.data;

  /*
   * Mount lifecycle is explicit: `serviceId` drives visibility and a timer drops
   * the node once the closing animation has had its time.
   *
   * Nothing here waits for an animation to report completion. A background tab
   * suspends requestAnimationFrame, so an overlay whose unmount depended on an
   * animation callback would stay mounted indefinitely — with a full-viewport
   * backdrop swallowing every click once the tab came back.
   */
  const [mounted, setMounted] = useState(serviceId !== null);

  useEffect(() => {
    if (serviceId !== null) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(timer);
  }, [serviceId]);

  if (!mounted) return null;
  const open = serviceId !== null;

  return (
    <>
      {
        <div
          className={clsx(
            'fixed inset-0 z-50 flex justify-end',
            open ? 'animate-fade-in' : 'animate-fade-out pointer-events-none',
          )}
        >
          <div className="absolute inset-0 bg-base/60 backdrop-blur-[2px]" onClick={onClose} />

          <aside
            // Wide by design: container lists, argv lines and log output are all
            // horizontal content that a narrow panel forces into wrapping.
            className={clsx(
              'glass relative flex h-full w-full max-w-[min(84rem,96vw)] flex-col border-l shadow-[-30px_0_80px_-40px_rgba(0,0,0,1)]',
              open ? 'animate-slide-in' : 'animate-slide-out',
            )}
            role="dialog"
            aria-modal="true"
            aria-label={service?.name ?? 'Service details'}
          >
            {detail.isPending && (
              <div className="flex flex-1 items-center justify-center gap-2 text-muted">
                <Loader2 className="size-4 animate-spin" /> loading service…
              </div>
            )}

            {detail.isError && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <AlertTriangle className="size-6 text-st-failed" />
                <p className="text-[14px] text-ink">Could not load this service</p>
                <p className="mono text-faint">{(detail.error as Error).message}</p>
                <button
                  type="button"
                  onClick={() => detail.refetch()}
                  className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2"
                >
                  Try again
                </button>
              </div>
            )}

            {service && (
              <>
                <DrawerHeader
                  service={service}
                  onClose={onClose}
                  onRefresh={() => refresh.mutate(service.id)}
                  refreshing={refresh.isPending || service.checking}
                />

                <nav className="flex shrink-0 gap-0.5 border-b border-line-soft px-3">
                  {(
                    [
                      ['overview', 'Overview', Info],
                      ['logs', 'Logs', ScrollText],
                      ['history', 'History', History],
                      ['config', 'Definition', Settings2],
                    ] as const
                  ).map(([id, label, Icon]) => {
                    const disabled = id === 'logs' && !service.supportsLogs;
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setTab(id)}
                        title={disabled ? 'This provider exposes no logs' : undefined}
                        className={clsx(
                          'relative flex items-center gap-1.5 px-3 py-2.5 text-[13.5px] font-medium transition-colors',
                          disabled && 'cursor-not-allowed opacity-35',
                          tab === id ? 'text-signal' : 'text-muted hover:text-ink',
                        )}
                      >
                        <Icon className="size-3.5" />
                        {label}
                        {id === 'history' && service.history.length > 0 && (
                          <span className="num rounded bg-surface-2 px-1 text-[11px] text-muted">
                            {service.history.length}
                          </span>
                        )}
                        {tab === id && (
                          <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-signal" />
                        )}
                      </button>
                    );
                  })}
                </nav>

                <div className="min-h-0 flex-1 overflow-hidden">
                  {tab === 'overview' && <OverviewTab service={service} />}
                  {tab === 'logs' && <LogPane serviceId={service.id} enabled={service.supportsLogs} />}
                  {tab === 'history' && <HistoryTab service={service} />}
                  {tab === 'config' && <ConfigTab service={service} />}
                </div>

                <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line-soft bg-base/40 px-4 py-3">
                  {/* The drawer has room, so every action is shown inline. */}
                  <ActionRow
                    service={service}
                    inlineKinds={['primary', 'secondary', 'danger', 'utility']}
                    inlineLimit={12}
                    onRun={(action) => onRunAction(service, action)}
                  />
                  <span className="text-[11.5px] text-faint">
                    checked {service.checking ? 'now' : formatAgo(service.lastCheckedAt)}
                  </span>
                </footer>
              </>
            )}
          </aside>
        </div>
      }
    </>
  );
}

/** Closing animation budget before the overlay is unmounted. */
const CLOSE_MS = 200;

function DrawerHeader({
  service,
  onClose,
  onRefresh,
  refreshing,
}: {
  service: ServiceDetail;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const Icon = iconFor(service.icon, service.type);
  const style = stateStyle(service.state);
  const uptime = formatUptime(service.since);

  return (
    <header className="relative shrink-0 border-b border-line-soft p-4">
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${style.color}, transparent)` }}
      />
      <div className="flex items-start gap-3">
        <div
          className="grid size-11 shrink-0 place-items-center rounded-xl border"
          style={{
            borderColor: `color-mix(in oklab, ${style.color} 35%, transparent)`,
            background: `color-mix(in oklab, ${style.color} 10%, transparent)`,
            color: style.color,
          }}
        >
          <Icon className="size-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[17px] font-semibold text-ink">{service.name}</h2>
            <StatusBadge state={service.state} />
          </div>
          <p className="mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-faint">
            <span>{service.id}</span>
            <span className="text-line">·</span>
            <span>{service.providerLabel}</span>
            <span className="text-line">·</span>
            <span>{service.group}</span>
            {uptime && (
              <>
                <span className="text-line">·</span>
                <span className="num flex items-center gap-1">
                  <Clock3 className="size-3" />
                  up {uptime}
                </span>
              </>
            )}
          </p>
          {service.description && <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{service.description}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Re-check status"
            title="Re-check status now"
            className="rounded-lg border border-line bg-surface-2/60 p-1.5 text-muted transition-colors hover:text-signal"
          >
            <RefreshCw className={clsx('size-3.5', refreshing && 'animate-spin text-signal')} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="rounded-lg border border-line bg-surface-2/60 p-1.5 text-muted transition-colors hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {service.busy && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-signal/25 bg-signal/[0.07] px-3 py-2 text-[13px] text-signal">
          <StatusIndicator state={service.state} size={10} />
          <span className="font-medium">{service.busy.label}</span>
          <span className="text-signal/70">running since {formatClock(service.busy.startedAt)}</span>
          <span className="ml-auto text-[11.5px] text-signal/60">other actions are locked</span>
        </div>
      )}
    </header>
  );
}

function OverviewTab({ service }: { service: ServiceDetail }) {
  const problems = [...service.errors.map((text) => ({ text, severe: true })), ...service.warnings.map((text) => ({ text, severe: false }))];

  return (
    <div className="h-full overflow-auto p-4">
      {(service.statusSummary || service.statusDetail) && (
        <section className="mb-4 rounded-xl border border-line-soft bg-surface-2/40 p-3">
          <p className="text-[13.5px] text-ink">{service.statusSummary ?? stateStyle(service.state).hint}</p>
          {service.statusDetail && <p className="mono mt-1.5 text-faint">{service.statusDetail}</p>}
        </section>
      )}

      {/* Two independent columns on wide viewports: diagnostics on the left,
          runtime inventory on the right. Below 1280px it collapses to one. */}
      <div className="grid items-start gap-x-6 gap-y-5 xl:grid-cols-2">
      {problems.length > 0 && (
        <Section title="Warnings" icon={AlertTriangle}>
          <ul className="space-y-1.5">
            {problems.map((problem, index) => (
              <li
                key={index}
                className={clsx(
                  'flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[13px] leading-relaxed',
                  problem.severe
                    ? 'border-st-failed/25 bg-st-failed/[0.07] text-st-failed'
                    : 'border-st-degraded/25 bg-st-degraded/[0.06] text-st-degraded',
                )}
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 break-words">{problem.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {service.metrics.length > 0 && (
        <Section title="Status detail" icon={Info}>
          <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {service.metrics.map((metric) => (
              <div
                key={metric.label}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-line-soft bg-surface-2/40 px-2.5 py-1.5"
              >
                <dt className="shrink-0 text-[12.5px] text-muted">{metric.label}</dt>
                <dd
                  className={clsx(
                    'num min-w-0 truncate text-right text-[13px] font-medium',
                    metric.kind === 'mono' && 'mono',
                    metric.tone === 'good' && 'text-st-running',
                    metric.tone === 'warn' && 'text-st-degraded',
                    metric.tone === 'bad' && 'text-st-failed',
                    (!metric.tone || metric.tone === 'default') && 'text-ink',
                  )}
                  title={metric.value}
                >
                  {formatMetric(metric)}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {service.childStatuses.length > 0 && (
        <Section title={`Containers · ${service.children?.running ?? 0}/${service.children?.total ?? 0} up`} icon={Boxes}>
          <ul className="space-y-1.5">
            {service.childStatuses.map((child) => (
              <ChildRow key={child.id} child={child} />
            ))}
          </ul>
        </Section>
      )}

      {(service.ports.length > 0 || service.urls.length > 0) && (
        <Section title="Endpoints" icon={Radio}>
          <div className="flex flex-wrap gap-1.5">
            {service.urls.map((url) => (
              <a
                key={url.url}
                href={url.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2/50 px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-signal/40 hover:text-signal"
              >
                {url.label}
                <ArrowUpRight className="size-3" />
              </a>
            ))}
            {service.ports.map((port) => (
              <span
                key={`${port.protocol}-${port.hostPort ?? port.port}`}
                className="num inline-flex items-center gap-1.5 rounded-lg border border-route/25 bg-route/10 px-2.5 py-1.5 text-[13px] text-route"
              >
                <Radio className="size-3" />
                {port.hostPort ? `${port.hostPort} → ${port.port}` : port.port}
                <span className="text-[11px] uppercase text-route/60">{port.protocol}</span>
                {port.label && <span className="text-route/70">{port.label}</span>}
              </span>
            ))}
          </div>
        </Section>
      )}

      {service.lastProbe?.argv && (
        // Full width: argv lines and raw output are the widest content here.
        <div className="xl:col-span-2">
          <Section title="Last status probe" icon={ScrollText}>
            <CommandOutputBlock output={service.lastProbe} />
          </Section>
        </div>
      )}
      </div>
    </div>
  );
}

function ChildRow({ child }: { child: ChildStatus }) {
  const style = stateStyle(child.state);
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2/40 px-2.5 py-2">
      <StatusIndicator state={child.state} size={10} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-ink">{child.name}</p>
        <p className="mono truncate text-faint">
          {child.stateLabel ?? style.label}
          {child.image && ` · ${child.image}`}
        </p>
      </div>
      {child.health && child.health !== 'none' && (
        <span
          className={clsx(
            'rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium',
            child.health === 'healthy' && 'border-st-running/30 bg-st-running/10 text-st-running',
            child.health === 'unhealthy' && 'border-st-failed/30 bg-st-failed/10 text-st-failed',
            child.health === 'starting' && 'border-st-starting/30 bg-st-starting/10 text-st-starting',
          )}
        >
          {child.health}
        </span>
      )}
      {child.ports && child.ports.length > 0 && (
        <span className="num hidden shrink-0 gap-1 text-[11.5px] text-route sm:flex">
          {child.ports.slice(0, 2).map((port) => port.hostPort ?? port.port).join(', ')}
        </span>
      )}
    </li>
  );
}

function HistoryTab({ service }: { service: ServiceDetail }) {
  if (service.history.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <History className="size-6 text-faint" />
        <p className="text-[14px] text-ink-2">No actions run yet</p>
        <p className="text-[13px] text-faint">Actions triggered from Switchyard appear here with their output.</p>
      </div>
    );
  }

  return (
    <div className="h-full space-y-2 overflow-auto p-4">
      {service.history.map((record, index) => (
        <details
          key={`${record.startedAt}-${index}`}
          className="group rounded-xl border border-line-soft bg-surface-2/40 open:bg-surface-2/60"
        >
          <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5">
            <span
              className={clsx(
                'size-1.5 shrink-0 rounded-full',
                record.ok ? 'bg-st-running' : 'bg-st-failed',
              )}
            />
            <span className="text-[13.5px] font-medium text-ink">{record.label}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{record.message}</span>
            <span className="num shrink-0 text-[11.5px] text-faint">{formatDuration(record.durationMs)}</span>
            <span className="num shrink-0 text-[11.5px] text-faint">{formatClock(record.startedAt)}</span>
          </summary>
          <div className="space-y-2 border-t border-line-soft px-3 py-2.5">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
              <span>
                action <span className="mono text-ink-2">{record.actionId}</span>
              </span>
              <span>
                exit <span className="num text-ink-2">{record.exitCode ?? '—'}</span>
              </span>
              <span>started {formatAgo(record.startedAt)}</span>
            </div>
            {record.excerpt && (
              <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-2 text-faint">
                {record.excerpt}
              </pre>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

function ConfigTab({ service }: { service: ServiceDetail }) {
  return (
    <div className="grid h-full items-start gap-x-6 gap-y-5 overflow-auto p-4 xl:grid-cols-2">
      <Section title="Service definition" icon={Settings2}>
        <dl className="space-y-1.5">
          <Row label="id" value={service.id} mono />
          <Row label="provider" value={`${service.type} (${service.providerLabel})`} />
          <Row label="group" value={service.group} />
          {service.tags.length > 0 && <Row label="tags" value={service.tags.join(', ')} />}
          <Row label="defined in" value={service.source} mono />
          {service.workdir && <Row label="workdir" value={service.workdir} mono />}
          <Row label="logs" value={service.supportsLogs ? 'supported' : 'not available'} />
          <Row
            label="actions"
            value={service.actions.map((action) => action.id).join(', ') || 'none'}
            mono
          />
        </dl>
      </Section>

      {service.envKeys.length > 0 && (
        <Section title="Environment" icon={FolderOpen}>
          <p className="mb-2 text-[12.5px] text-faint">
            Values are never sent to the browser — only the variable names.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {service.envKeys.map((key) => (
              <span key={key} className="mono rounded-md border border-line-soft bg-surface-2/50 px-1.5 py-0.5 text-ink-2">
                {key}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title="Provider configuration" icon={Settings2}>
        <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-3 text-ink-2">
          {JSON.stringify(service.providerConfig, null, 2)}
        </pre>
      </Section>

      {service.raw && Object.keys(service.raw).length > 0 && (
        <Section title="Backend properties" icon={Info}>
          <dl className="space-y-1">
            {Object.entries(service.raw).map(([key, value]) => (
              <Row key={key} label={key} value={value || '—'} mono />
            ))}
          </dl>
        </Section>
      )}
    </div>
  );
}

function CommandOutputBlock({ output }: { output: NonNullable<ServiceDetail['lastProbe']> }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
        <span>
          exit <span className="num text-ink-2">{output.exitCode ?? '—'}</span>
        </span>
        {output.durationMs !== undefined && (
          <span>
            took <span className="num text-ink-2">{output.durationMs} ms</span>
          </span>
        )}
      </div>
      {output.argv && (
        // Wrap rather than hide behind a scrollbar: argv lines with long
        // --format templates are exactly what someone reads this block for.
        <pre className="mono whitespace-pre-wrap break-all rounded-lg border border-line bg-base/60 p-2 text-signal/80">
          {output.argv.join(' ')}
        </pre>
      )}
      {output.stdout && (
        <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-2 text-ink-2">
          {output.stdout}
        </pre>
      )}
      {output.stderr && (
        <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-st-degraded/20 bg-st-degraded/[0.05] p-2 text-st-degraded/90">
          {output.stderr}
        </pre>
      )}
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">
        <Icon className="size-3.5" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft/60 pb-1 last:border-0">
      <dt className="shrink-0 text-[12.5px] text-muted">{label}</dt>
      <dd className={clsx('min-w-0 break-all text-right text-[13px] text-ink', mono && 'mono')}>{value}</dd>
    </div>
  );
}
