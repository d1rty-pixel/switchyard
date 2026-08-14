import { Activity, ArrowUpRight, Clock3, Gauge, Radio, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { formatAgo, formatMetric, formatResource, formatUptime } from '@/lib/format';
import { alertTone } from '@/lib/resources';
import { toneStyle } from '@/lib/status';
import { StatusIndicator } from './StatusIndicator';
import type { ResourceEntry } from '@/lib/resources';
import type { Metric, PortInfo, ServiceSummary, UrlInfo } from '@/lib/types';

/**
 * The small facts a service shows about itself: provider, ports, endpoints,
 * load, uptime. Card, table row and drawer all show the same ones, so each is
 * rendered from one place here rather than re-assembled per view — the tone
 * mapping in particular (`toneStyle`) has to agree across the three, or the
 * same alert reads as two different severities depending on where you look.
 */

/** Squared-off chip geometry, as opposed to the pill shape Badge defaults to. */
const CHIP = 'rounded-md border px-1.5 text-[12px] font-normal';

export function ProviderChip({ service, className }: { service: ServiceSummary; className?: string }) {
  return (
    <span className={cn('flex items-center gap-1.5 text-[12px] text-muted-foreground', className)}>
      <span className="rounded border border-border bg-popover/60 px-1.5 py-px font-medium text-muted-foreground">
        {service.providerLabel}
      </span>
      {service.children && (
        <span className="tabular-nums">
          {service.children.running}/{service.children.total} containers
        </span>
      )}
    </span>
  );
}

export function PortChip({ port, className }: { port: PortInfo; className?: string }) {
  return (
    <Badge
      variant="outline"
      title={port.label ? `${port.label} (${port.protocol})` : port.protocol}
      className={cn(CHIP, 'tabular-nums border-secondary/25 bg-secondary/10 text-secondary', className)}
    >
      <Radio />
      {port.hostPort ?? port.port}
    </Badge>
  );
}

export function EndpointLink({ url, className }: { url: UrlInfo; className?: string }) {
  return (
    <Badge
      asChild
      variant="outline"
      className={cn(CHIP, 'border-border bg-popover/50 text-muted-foreground hover:border-primary/40 hover:text-primary', className)}
    >
      <a href={url.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
        {url.label}
        <ArrowUpRight />
      </a>
    </Badge>
  );
}

/** One measured metric — CPU, memory, disk, network — with its alert tone. */
export function ResourceChip({
  entry,
  attribution,
  className,
}: {
  entry: ResourceEntry;
  attribution?: string;
  className?: string;
}) {
  const tone = toneStyle(alertTone(entry.alert?.severity));
  return (
    <Badge
      variant="outline"
      title={
        entry.alert
          ? `${entry.label}: ${formatResource(entry.value, entry.unit)} — ${entry.alert.severity} threshold ${formatResource(entry.alert.threshold, entry.unit)}`
          : `${entry.label} · ${attribution ?? ''}`
      }
      className={cn(CHIP, entry.alert ? tone.chip : 'border-border bg-popover/50 text-muted-foreground', className)}
    >
      {entry.metric === 'cpu' ? <Gauge className="opacity-70" /> : <Activity className="opacity-70" />}
      <span className="text-muted-foreground">{entry.short}</span>
      <span className="tabular-nums font-medium">{formatResource(entry.value, entry.unit)}</span>
    </Badge>
  );
}

/** A provider-declared metric, rendered according to its declared kind. */
export function MetricChip({ metric, className }: { metric: Metric; className?: string }) {
  return (
    <Badge
      variant="outline"
      title={metric.label}
      className={cn(CHIP, 'border-border bg-popover/50', toneStyle(metric.tone).text, className)}
    >
      <span className="text-muted-foreground">{metric.label}</span>
      <span className="tabular-nums font-medium">{formatMetric(metric)}</span>
    </Badge>
  );
}

/**
 * The coloured bar down the left edge of a card or row. Placed by the caller
 * (`inset-y-*` differs between the two), coloured from the state here.
 */
export function StateRail({ color, dimmed, className }: { color: string; dimmed: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('absolute left-0 w-[2px] rounded-full transition-colors duration-300', className)}
      style={{ background: color, boxShadow: `0 0 14px -2px ${color}`, opacity: dimmed ? 0.45 : 0.9 }}
    />
  );
}

export function UptimeLabel({ service }: { service: ServiceSummary }) {
  const uptime = formatUptime(service.since);
  if (!uptime) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="tabular-nums flex items-center gap-1" title={`Since ${service.since}`}>
      <Clock3 className="size-3 text-muted-foreground" />
      {uptime}
    </span>
  );
}

/** What the service is doing right now — a running action, or its own summary. */
export function ActivityLine({ service, className }: { service: ServiceSummary; className?: string }) {
  if (service.busy) {
    return (
      <span className={cn('flex items-center gap-1.5 text-primary', className)}>
        <StatusIndicator state={service.state} size={9} />
        {service.busy.label} running…
      </span>
    );
  }
  if (!service.statusSummary) return null;
  return (
    <span className={cn('min-w-0 truncate', className)} title={service.statusSummary}>
      {service.statusSummary}
    </span>
  );
}

/** Trailing "what happened last / checked when" pair, shown by card and row. */
export function LastCheckedInfo({
  service,
  actionClassName,
}: {
  service: ServiceSummary;
  /** Which breakpoint the last-action half appears at; it is the first to go. */
  actionClassName?: string;
}) {
  return (
    <>
      {service.lastAction && (
        <span
          title={`${service.lastAction.label}: ${service.lastAction.message}`}
          className={cn(
            'hidden items-center gap-1',
            actionClassName ?? 'sm:flex',
            service.lastAction.ok ? 'text-muted-foreground' : 'text-red-500/80',
          )}
        >
          <ScrollText className="size-3" />
          {service.lastAction.label}
        </span>
      )}
      <span title={service.lastCheckedAt ? `Last status check: ${service.lastCheckedAt}` : 'Never checked'}>
        {service.checking ? 'checking…' : formatAgo(service.lastCheckedAt)}
      </span>
    </>
  );
}
