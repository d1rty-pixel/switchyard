import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  Clock3,
  FolderOpen,
  Gauge,
  History,
  Info,
  Loader2,
  RefreshCw,
  Radio,
  ScrollText,
  Settings2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { hasGpuAcceleration } from '@/lib/gpu';
import { useRefreshService, useServiceDetail } from '@/lib/hooks';
import { formatAgo, formatClock, formatDuration, formatMetric, formatResource, formatUptime } from '@/lib/format';
import { iconFor } from '@/lib/icons';
import { alertTone, resourceEntries } from '@/lib/resources';
import { stateStyle, toneStyle } from '@/lib/status';
import { Callout } from './Callout';
import { EndpointLink } from './ServiceChips';
import { StatusBadge, StatusIndicator } from './StatusIndicator';
import { ActionRow } from './ActionControls';
import { containerOptionsFrom, LogPane } from './LogPane';
import type {
  ActionDescriptor,
  ChildStatus,
  HistoryEntry,
  HistoryKind,
  HistorySeverity,
  ResourceAlert,
  ServiceDetail,
  ServiceSummary,
} from '@/lib/types';

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
  // A large shadow blur radius is near-free on a GPU compositor but gets
  // rasterized on the main thread without one — right on the animation path,
  // so a software renderer turns the open/close slide janky.
  const gpu = hasGpuAcceleration();

  return (
    <Sheet open={serviceId !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        // Wide by design: container lists, argv lines and log output are all
        // horizontal content that a narrow panel forces into wrapping. The
        // width has to be stated on the same `data-[side]` variant SheetContent
        // uses, or its own `sm:max-w-sm` is never displaced.
        className={cn(
          'glass gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[min(84rem,96vw)]',
          gpu ? 'shadow-[-30px_0_80px_-40px_rgba(0,0,0,1)]' : 'shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.6)]',
        )}
      >
        {detail.isPending && (
          <>
            <SheetTitle className="sr-only">Loading service</SheetTitle>
            <div className="flex flex-1 items-center justify-center gap-2 text-ink-3">
              <Loader2 className="size-4 animate-spin" /> loading service…
            </div>
          </>
        )}

        {detail.isError && (
          <>
            <SheetTitle className="sr-only">Service details unavailable</SheetTitle>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <AlertTriangle className="size-6 text-st-failed" />
              <p className="text-[14px] text-ink">Could not load this service</p>
              <p className="mono text-faint">{(detail.error as Error).message}</p>
              <Button variant="outline" onClick={() => detail.refetch()}>
                Try again
              </Button>
            </div>
          </>
        )}

        {service && (
          <>
            <DrawerHeader
              service={service}
              onClose={onClose}
              onRefresh={() => refresh.mutate(service.id)}
              refreshing={refresh.isPending || service.checking}
            />

            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as Tab)}
              className="min-h-0 flex-1 gap-0"
            >
              <TabsList variant="line" className="h-auto shrink-0 gap-0.5 border-b border-line-soft px-3">
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
                    <TabsTrigger
                      key={id}
                      value={id}
                      disabled={disabled}
                      title={disabled ? 'This provider exposes no logs' : undefined}
                      className="px-3 py-2.5 text-[13.5px] text-ink-3 after:bg-signal hover:text-ink data-active:text-signal dark:text-ink-3 dark:hover:text-ink dark:data-active:text-signal"
                    >
                      <Icon className="size-3.5" />
                      {label}
                      {id === 'history' && service.history.length > 0 && (
                        <span className="num rounded bg-surface-2 px-1 text-[11px] text-ink-3">
                          {service.history.length}
                        </span>
                      )}
                    </TabsTrigger>
                  );
                })}
              </TabsList>

              <div className="min-h-0 flex-1 overflow-hidden">
                <TabsContent value="overview" className="h-full">
                  <OverviewTab service={service} />
                </TabsContent>
                <TabsContent value="logs" className="h-full">
                  <LogPane
                    serviceId={service.id}
                    enabled={service.supportsLogs}
                    containerOptions={containerOptionsFrom(service.childStatuses)}
                  />
                </TabsContent>
                <TabsContent value="history" className="h-full">
                  <HistoryTab service={service} />
                </TabsContent>
                <TabsContent value="config" className="h-full">
                  <ConfigTab service={service} />
                </TabsContent>
              </div>
            </Tabs>

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
      </SheetContent>
    </Sheet>
  );
}

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
            <SheetTitle className="truncate text-[17px] font-semibold text-ink">{service.name}</SheetTitle>
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
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onRefresh}
            aria-label="Re-check status"
            title="Re-check status now"
            className="border-line bg-surface-2/60 text-ink-3 hover:text-signal"
          >
            <RefreshCw className={cn(refreshing && 'animate-spin text-signal')} />
          </Button>
          <SheetClose asChild>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close details"
              className="border-line bg-surface-2/60 text-ink-3 hover:text-ink"
            >
              <X />
            </Button>
          </SheetClose>
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
              <Callout key={index} as="li" tone={problem.severe ? 'bad' : 'warn'} icon={AlertTriangle}>
                {problem.text}
              </Callout>
            ))}
          </ul>
        </Section>
      )}

      {(service.alerts.length > 0 || service.resources) && <ResourcesSection service={service} />}

      {service.metrics.length > 0 && (
        <Section title="Status detail" icon={Info}>
          <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {service.metrics.map((metric) => (
              <div
                key={metric.label}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-line-soft bg-surface-2/40 px-2.5 py-1.5"
              >
                <dt className="shrink-0 text-[12.5px] text-ink-3">{metric.label}</dt>
                <dd
                  className={cn(
                    'num min-w-0 truncate text-right text-[13px] font-medium',
                    metric.kind === 'mono' && 'mono',
                    toneStyle(metric.tone).text,
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
              <EndpointLink key={url.url} url={url} className="h-auto rounded-lg px-2.5 py-1.5 text-[13px]" />
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

/**
 * Live resource usage and active alerts.
 *
 * The attribution line is not decoration: "systemd cgroup" and "main PID only"
 * are different measurements, and a reader deciding whether 40 % CPU is the whole
 * service or just its parent process needs to be told which one this is.
 */
function ResourcesSection({ service }: { service: ServiceDetail }) {
  const sample = service.resources;
  const entries = sample ? resourceEntries(sample, service.alerts) : [];

  return (
    <Section title="Resources" icon={Gauge}>
      {service.alerts.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {service.alerts.map((alert) => (
            <AlertRow key={alert.key} alert={alert} />
          ))}
        </ul>
      )}

      {entries.length > 0 ? (
        <>
          <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {entries.map((entry) => (
              <div
                key={entry.metric}
                className="flex items-baseline justify-between gap-3 rounded-lg border border-line-soft bg-surface-2/40 px-2.5 py-1.5"
              >
                <dt className="shrink-0 text-[12.5px] text-ink-3">{entry.label}</dt>
                <dd
                  className={cn(
                    'num min-w-0 truncate text-right text-[13px] font-medium',
                    toneStyle(alertTone(entry.alert?.severity)).text,
                  )}
                >
                  {formatResource(entry.value, entry.unit)}
                  {entry.metric === 'memory' && sample?.memoryLimitBytes !== undefined && (
                    <span className="text-faint"> / {formatResource(sample.memoryLimitBytes, 'bytes')}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-1.5 text-[12px] text-faint">
            {sample?.attribution} · sampled {formatAgo(sample?.at)}
          </p>
        </>
      ) : (
        <p className="text-[13px] text-faint">
          {service.monitored
            ? 'No samples yet — nothing measurable while the service is not running.'
            : 'This provider reports no resource samples.'}
        </p>
      )}

      {sample?.children && sample.children.length > 0 && (
        <ul className="mt-2 space-y-1">
          {sample.children.map((child) => (
            <li
              key={child.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-line-soft bg-surface-2/30 px-2.5 py-1.5"
            >
              <span className="mono min-w-0 flex-1 truncate text-ink-2">{child.name}</span>
              {resourceEntries(child).map((entry) => (
                <span key={entry.metric} className="num text-[12.5px] text-ink-3">
                  <span className="text-faint">{entry.short} </span>
                  {formatResource(entry.value, entry.unit)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function AlertRow({ alert }: { alert: ResourceAlert }) {
  return (
    <Callout as="li" tone={alertTone(alert.severity)} icon={Gauge}>
      <span className="font-medium">
        {alert.label} {alert.severity}
      </span>{' '}
      — {formatResource(alert.value, alert.unit)} against a threshold of{' '}
      {formatResource(alert.threshold, alert.unit)}.{' '}
      <span className="text-faint">
        breach began {formatAgo(alert.breachedAt)}, alerting since {formatAgo(alert.activatedAt)}
        {alert.stale && ' · no fresh samples'}
      </span>
    </Callout>
  );
}

/* Container health is the provider's own vocabulary, not a service state — it
   maps onto the same status colours but has no entry in STATE_STYLES. */
const HEALTH_CHIP: Record<string, string> = {
  healthy: 'border-st-running/30 bg-st-running/10 text-st-running',
  unhealthy: 'border-st-failed/30 bg-st-failed/10 text-st-failed',
  starting: 'border-st-starting/30 bg-st-starting/10 text-st-starting',
};

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
        <Badge
          variant="outline"
          className={cn('rounded-md border px-1.5 text-[11.5px]', HEALTH_CHIP[child.health])}
        >
          {child.health}
        </Badge>
      )}
      {child.ports && child.ports.length > 0 && (
        <span className="num hidden shrink-0 gap-1 text-[11.5px] text-route sm:flex">
          {child.ports.slice(0, 2).map((port) => port.hostPort ?? port.port).join(', ')}
        </span>
      )}
    </li>
  );
}

const HISTORY_DOT: Record<HistorySeverity, string> = {
  info: 'bg-st-running',
  warning: 'bg-st-degraded',
  error: 'bg-st-failed',
};

const HISTORY_KIND_LABEL: Record<HistoryKind, string> = {
  action: 'action',
  rejected: 'rejected',
  alert: 'alert',
  state: 'state',
  probe: 'probe',
  config: 'config',
};

function HistoryTab({ service }: { service: ServiceDetail }) {
  if (service.history.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <History className="size-6 text-faint" />
        <p className="text-[14px] text-ink-2">Nothing has happened yet</p>
        <p className="text-[13px] text-faint">
          Actions, alerts, state changes and probe failures appear here as they happen.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full space-y-2 overflow-auto p-4">
      {service.history.map((entry, index) => (
        <HistoryRow key={`${entry.at}-${index}`} entry={entry} />
      ))}
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const headline = (
    <>
      <span className={cn('size-1.5 shrink-0 rounded-full', HISTORY_DOT[entry.severity])} />
      <span className="text-[13.5px] font-medium text-ink">{entry.label}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">{entry.message}</span>
      {entry.action && (
        <span className="num shrink-0 text-[11.5px] text-faint">{formatDuration(entry.action.durationMs)}</span>
      )}
      <span className="num shrink-0 text-[11.5px] text-faint">{formatClock(entry.at)}</span>
    </>
  );

  // Only actions and alerts carry anything worth unfolding; the rest say
  // everything they have to say in one line, and a disclosure triangle that
  // opens onto a repeat of the summary is worse than no triangle.
  const details = entry.action ? (
    <div className="space-y-2 border-t border-line-soft px-3 py-2.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
        <span>
          action <span className="mono text-ink-2">{entry.action.actionId}</span>
        </span>
        <span>
          exit <span className="num text-ink-2">{entry.action.exitCode ?? '—'}</span>
        </span>
        <span>started {formatAgo(entry.at)}</span>
      </div>
      {entry.action.excerpt && (
        <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-2 text-faint">
          {entry.action.excerpt}
        </pre>
      )}
    </div>
  ) : entry.alert ? (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line-soft px-3 py-2.5 text-[12px] text-faint">
      <span>
        metric <span className="mono text-ink-2">{entry.alert.metric}</span>
      </span>
      <span>
        measured <span className="num text-ink-2">{formatResource(entry.alert.value, entry.alert.unit)}</span>
      </span>
      <span>
        {entry.alert.severity} threshold{' '}
        <span className="num text-ink-2">{formatResource(entry.alert.threshold, entry.alert.unit)}</span>
      </span>
      <span>{formatAgo(entry.at)}</span>
    </div>
  ) : null;

  if (!details) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-line-soft bg-surface-2/40 px-3 py-2.5">
        {headline}
        <span className="shrink-0 text-[11.5px] text-faint">{HISTORY_KIND_LABEL[entry.kind]}</span>
      </div>
    );
  }

  return (
    <details className="group rounded-xl border border-line-soft bg-surface-2/40 open:bg-surface-2/60">
      <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5">{headline}</summary>
      {details}
    </details>
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

      {/* Effective values, i.e. the global monitoring block already merged in —
          which is the thing that is hard to work out from the files alone. */}
      <Section title="Monitoring (effective)" icon={Gauge}>
        <pre className="mono max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-base/60 p-3 text-ink-2">
          {JSON.stringify(service.monitoringConfig, null, 2)}
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
      <dt className="shrink-0 text-[12.5px] text-ink-3">{label}</dt>
      <dd className={cn('min-w-0 break-all text-right text-[13px] text-ink', mono && 'mono')}>{value}</dd>
    </div>
  );
}
