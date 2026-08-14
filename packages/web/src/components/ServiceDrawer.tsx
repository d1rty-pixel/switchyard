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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { hasGpuAcceleration } from '@/lib/gpu';
import { useRefreshService, useServiceDetail } from '@/lib/hooks';
import { formatAgo, formatClock, formatDuration, formatMetric, formatResource, formatUptime } from '@/lib/format';
import { iconFor } from '@/lib/icons';
import { alertTone, resourceEntries, RESOURCE_METRIC_INFO, RESOURCE_ORDER } from '@/lib/resources';
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
  ResolvedMonitoring,
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
          'gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-[min(84rem,96vw)]',
          gpu ? 'shadow-[-30px_0_80px_-40px_rgba(0,0,0,1)]' : 'shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.6)]',
        )}
      >
        {detail.isPending && (
          <>
            <SheetTitle className="sr-only">Loading service</SheetTitle>
            <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> loading service…
            </div>
          </>
        )}

        {detail.isError && (
          <>
            <SheetTitle className="sr-only">Service details unavailable</SheetTitle>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <AlertTriangle className="size-6 text-red-500" />
              <p className="text-[14px] text-foreground">Could not load this service</p>
              <p className="font-mono text-muted-foreground">{(detail.error as Error).message}</p>
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
              <TabsList variant="line" className="h-auto shrink-0 gap-0.5 border-b border-border px-3">
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
                      className="px-3 py-2.5 text-[13.5px] text-muted-foreground after:bg-primary hover:text-foreground data-active:text-primary dark:text-muted-foreground dark:hover:text-foreground dark:data-active:text-primary"
                    >
                      <Icon className="size-3.5" />
                      {label}
                      {id === 'history' && service.history.length > 0 && (
                        <span className="tabular-nums rounded bg-popover px-1 text-[11px] text-muted-foreground">
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

            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/40 px-4 py-3">
              {/* The drawer has room, so every action is shown inline. */}
              <ActionRow
                service={service}
                inlineKinds={['primary', 'secondary', 'danger', 'utility']}
                inlineLimit={12}
                onRun={(action) => onRunAction(service, action)}
              />
              <span className="text-[11.5px] text-muted-foreground">
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
    <header className="relative shrink-0 border-b border-border p-4">
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
            <SheetTitle className="truncate text-[17px] font-semibold text-foreground">{service.name}</SheetTitle>
            <StatusBadge state={service.state} />
          </div>
          <p className="font-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
            <span>{service.id}</span>
            <span className="text-border">·</span>
            <span>{service.providerLabel}</span>
            <span className="text-border">·</span>
            <span>{service.group}</span>
            {uptime && (
              <>
                <span className="text-border">·</span>
                <span className="tabular-nums flex items-center gap-1">
                  <Clock3 className="size-3" />
                  up {uptime}
                </span>
              </>
            )}
          </p>
          {service.description && <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{service.description}</p>}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={onRefresh}
            aria-label="Re-check status"
            title="Re-check status now"
            className="border-border bg-popover/60 text-muted-foreground hover:text-primary"
          >
            <RefreshCw className={cn(refreshing && 'animate-spin text-primary')} />
          </Button>
          <SheetClose asChild>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close details"
              className="border-border bg-popover/60 text-muted-foreground hover:text-foreground"
            >
              <X />
            </Button>
          </SheetClose>
        </div>
      </div>

      {service.busy && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/[0.07] px-3 py-2 text-[13px] text-primary">
          <StatusIndicator state={service.state} size={10} />
          <span className="font-medium">{service.busy.label}</span>
          <span className="text-primary/70">running since {formatClock(service.busy.startedAt)}</span>
          <span className="ml-auto text-[11.5px] text-primary/60">other actions are locked</span>
        </div>
      )}
    </header>
  );
}

function OverviewTab({ service }: { service: ServiceDetail }) {
  const problems = [...service.errors.map((text) => ({ text, severe: true })), ...service.warnings.map((text) => ({ text, severe: false }))];

  return (
    <ScrollArea className="h-full">
    <div className="p-4">
      {(service.statusSummary || service.statusDetail) && (
        <section className="mb-4 rounded-xl border border-border bg-popover/40 p-3">
          <p className="text-[13.5px] text-foreground">{service.statusSummary ?? stateStyle(service.state).hint}</p>
          {service.statusDetail && <p className="font-mono mt-1.5 text-muted-foreground">{service.statusDetail}</p>}
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
                className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-popover/40 px-2.5 py-1.5"
              >
                <dt className="shrink-0 text-[12.5px] text-muted-foreground">{metric.label}</dt>
                <dd
                  className={cn(
                    'tabular-nums min-w-0 truncate text-right text-[13px] font-medium',
                    metric.kind === 'mono' && 'font-mono',
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
                className="tabular-nums inline-flex items-center gap-1.5 rounded-lg border border-secondary/25 bg-secondary/10 px-2.5 py-1.5 text-[13px] text-secondary"
              >
                <Radio className="size-3" />
                {port.hostPort ? `${port.hostPort} → ${port.port}` : port.port}
                <span className="text-[11px] uppercase text-secondary/60">{port.protocol}</span>
                {port.label && <span className="text-secondary/70">{port.label}</span>}
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
    </ScrollArea>
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
                className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-popover/40 px-2.5 py-1.5"
              >
                <dt className="shrink-0 text-[12.5px] text-muted-foreground">{entry.label}</dt>
                <dd
                  className={cn(
                    'tabular-nums min-w-0 truncate text-right text-[13px] font-medium',
                    toneStyle(alertTone(entry.alert?.severity)).text,
                  )}
                >
                  {formatResource(entry.value, entry.unit)}
                  {entry.metric === 'memory' && sample?.memoryLimitBytes !== undefined && (
                    <span className="text-muted-foreground"> / {formatResource(sample.memoryLimitBytes, 'bytes')}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            {sample?.attribution} · sampled {formatAgo(sample?.at)}
          </p>
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
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
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg border border-border bg-popover/30 px-2.5 py-1.5"
            >
              <span className="font-mono min-w-0 flex-1 truncate text-muted-foreground">{child.name}</span>
              {resourceEntries(child).map((entry) => (
                <span key={entry.metric} className="tabular-nums text-[12.5px] text-muted-foreground">
                  <span className="text-muted-foreground">{entry.short} </span>
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
      <span className="text-muted-foreground">
        breach began {formatAgo(alert.breachedAt)}, alerting since {formatAgo(alert.activatedAt)}
        {alert.stale && ' · no fresh samples'}
      </span>
    </Callout>
  );
}

/* Container health is the provider's own vocabulary, not a service state — it
   maps onto the same status colours but has no entry in STATE_STYLES. */
const HEALTH_CHIP: Record<string, string> = {
  healthy: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
  unhealthy: 'border-red-500/30 bg-red-500/10 text-red-500',
  starting: 'border-sky-500/30 bg-sky-500/10 text-sky-500',
};

function ChildRow({ child }: { child: ChildStatus }) {
  const style = stateStyle(child.state);
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border bg-popover/40 px-2.5 py-2">
      <StatusIndicator state={child.state} size={10} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13.5px] font-medium text-foreground">{child.name}</p>
        <p className="font-mono truncate text-muted-foreground">
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
        <span className="tabular-nums hidden shrink-0 gap-1 text-[11.5px] text-secondary sm:flex">
          {child.ports.slice(0, 2).map((port) => port.hostPort ?? port.port).join(', ')}
        </span>
      )}
    </li>
  );
}

const HISTORY_DOT: Record<HistorySeverity, string> = {
  info: 'bg-emerald-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
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
        <History className="size-6 text-muted-foreground" />
        <p className="text-[14px] text-muted-foreground">Nothing has happened yet</p>
        <p className="text-[13px] text-muted-foreground">
          Actions, alerts, state changes and probe failures appear here as they happen.
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
    <div className="space-y-2 p-4">
      {service.history.map((entry, index) => (
        <HistoryRow key={`${entry.at}-${index}`} entry={entry} />
      ))}
    </div>
    </ScrollArea>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const headline = (
    <>
      <span className={cn('size-1.5 shrink-0 rounded-full', HISTORY_DOT[entry.severity])} />
      <span className="text-[13.5px] font-medium text-foreground">{entry.label}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">{entry.message}</span>
      {entry.action && (
        <span className="tabular-nums shrink-0 text-[11.5px] text-muted-foreground">{formatDuration(entry.action.durationMs)}</span>
      )}
      <span className="tabular-nums shrink-0 text-[11.5px] text-muted-foreground">{formatClock(entry.at)}</span>
    </>
  );

  // Only actions and alerts carry anything worth unfolding; the rest say
  // everything they have to say in one line, and a disclosure triangle that
  // opens onto a repeat of the summary is worse than no triangle.
  const details = entry.action ? (
    <div className="space-y-2 border-t border-border px-3 py-2.5">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <span>
          action <span className="font-mono text-muted-foreground">{entry.action.actionId}</span>
        </span>
        <span>
          exit <span className="tabular-nums text-muted-foreground">{entry.action.exitCode ?? '—'}</span>
        </span>
        <span>started {formatAgo(entry.at)}</span>
      </div>
      {entry.action.excerpt && (
        <ScrollArea className="h-40 rounded-lg border border-border bg-muted">
          <pre className="font-mono whitespace-pre-wrap p-2 text-muted-foreground">{entry.action.excerpt}</pre>
        </ScrollArea>
      )}
    </div>
  ) : entry.alert ? (
    <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2.5 text-[12px] text-muted-foreground">
      <span>
        metric <span className="font-mono text-muted-foreground">{entry.alert.metric}</span>
      </span>
      <span>
        measured <span className="tabular-nums text-muted-foreground">{formatResource(entry.alert.value, entry.alert.unit)}</span>
      </span>
      <span>
        {entry.alert.severity} threshold{' '}
        <span className="tabular-nums text-muted-foreground">{formatResource(entry.alert.threshold, entry.alert.unit)}</span>
      </span>
      <span>{formatAgo(entry.at)}</span>
    </div>
  ) : null;

  if (!details) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-border bg-popover/40 px-3 py-2.5">
        {headline}
        <span className="shrink-0 text-[11.5px] text-muted-foreground">{HISTORY_KIND_LABEL[entry.kind]}</span>
      </div>
    );
  }

  return (
    <details className="group rounded-xl border border-border bg-popover/40 open:bg-popover/60">
      <summary className="flex cursor-pointer items-center gap-2.5 px-3 py-2.5">{headline}</summary>
      {details}
    </details>
  );
}

/** Effective monitoring config, rendered as a table rather than raw JSON. */
function MonitoringTable({ monitoring }: { monitoring: ResolvedMonitoring }) {
  const rows = RESOURCE_ORDER.filter((metric) => monitoring.thresholds[metric]);

  return (
    <div className="space-y-2.5">
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <dt>monitoring</dt>
          <dd>
            <Badge
              variant="outline"
              className={cn(
                'h-auto px-1.5 py-0 text-[11px]',
                monitoring.enabled
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                  : 'border-slate-500/30 bg-slate-500/10 text-slate-500',
              )}
            >
              {monitoring.enabled ? 'enabled' : 'disabled'}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="inline">clear below</dt> <dd className="inline tabular-nums">{monitoring.clearBelow}%</dd>
        </div>
        <div>
          <dt className="inline">cooldown</dt>{' '}
          <dd className="inline tabular-nums">{formatDuration(monitoring.cooldownMs)}</dd>
        </div>
      </dl>

      {rows.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent [&>th]:border-b [&>th]:border-border">
                <TableHead className="h-auto px-2.5 py-1.5 text-[11.5px]">Metric</TableHead>
                <TableHead className="h-auto px-2.5 py-1.5 text-right text-[11.5px]">Warning</TableHead>
                <TableHead className="h-auto px-2.5 py-1.5 text-right text-[11.5px]">Critical</TableHead>
                <TableHead className="h-auto px-2.5 py-1.5 text-right text-[11.5px]">Sustained for</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((metric) => {
                const threshold = monitoring.thresholds[metric]!;
                return (
                  <TableRow key={metric} className="border-border/60">
                    <TableCell className="px-2.5 py-1.5 text-[12.5px] text-foreground">
                      {RESOURCE_METRIC_INFO[metric].label}
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5 text-right text-[12.5px] tabular-nums text-amber-500">
                      {threshold.warning !== undefined ? formatResource(threshold.warning, threshold.unit) : '—'}
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5 text-right text-[12.5px] tabular-nums text-red-500">
                      {threshold.critical !== undefined ? formatResource(threshold.critical, threshold.unit) : '—'}
                    </TableCell>
                    <TableCell className="px-2.5 py-1.5 text-right text-[12.5px] tabular-nums text-muted-foreground">
                      {formatDuration(threshold.forMs)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">No thresholds configured.</p>
      )}
    </div>
  );
}

function ConfigTab({ service }: { service: ServiceDetail }) {
  return (
    <ScrollArea className="h-full">
    <div className="grid items-start gap-x-6 gap-y-5 p-4 xl:grid-cols-2">
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
          <p className="mb-2 text-[12.5px] text-muted-foreground">
            Values are never sent to the browser — only the variable names.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {service.envKeys.map((key) => (
              <span key={key} className="font-mono rounded-md border border-border bg-popover/50 px-1.5 py-0.5 text-muted-foreground">
                {key}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title="Provider configuration" icon={Settings2}>
        <ScrollArea className="h-80 rounded-lg border border-border bg-muted">
          <pre className="font-mono whitespace-pre-wrap p-3 text-muted-foreground">
            {JSON.stringify(service.providerConfig, null, 2)}
          </pre>
        </ScrollArea>
      </Section>

      {/* Effective values, i.e. the global monitoring block already merged in —
          which is the thing that is hard to work out from the files alone. */}
      <Section title="Monitoring (effective)" icon={Gauge}>
        <MonitoringTable monitoring={service.monitoringConfig} />
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
    </ScrollArea>
  );
}

function CommandOutputBlock({ output }: { output: NonNullable<ServiceDetail['lastProbe']> }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span>
          exit <span className="tabular-nums text-muted-foreground">{output.exitCode ?? '—'}</span>
        </span>
        {output.durationMs !== undefined && (
          <span>
            took <span className="tabular-nums text-muted-foreground">{output.durationMs} ms</span>
          </span>
        )}
      </div>
      {output.argv && (
        // Wrap rather than hide behind a scrollbar: argv lines with long
        // --format templates are exactly what someone reads this block for.
        <pre className="font-mono whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-2 text-primary/80">
          {output.argv.join(' ')}
        </pre>
      )}
      {output.stdout && (
        <ScrollArea className="h-48 rounded-lg border border-border bg-muted">
          <pre className="font-mono whitespace-pre-wrap break-all p-2 text-muted-foreground">{output.stdout}</pre>
        </ScrollArea>
      )}
      {output.stderr && (
        <ScrollArea className="h-48 rounded-lg border border-amber-500/20 bg-amber-500/[0.05]">
          <pre className="font-mono whitespace-pre-wrap break-all p-2 text-amber-500/90">{output.stderr}</pre>
        </ScrollArea>
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
      <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1 last:border-0">
      <dt className="shrink-0 text-[12.5px] text-muted-foreground">{label}</dt>
      <dd className={cn('min-w-0 break-all text-right text-[13px] text-foreground', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}
