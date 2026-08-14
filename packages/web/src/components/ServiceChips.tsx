import { Activity, ArrowUpRight, Clock3, Gauge, Radio, ScrollText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
      <span className="rounded border border-border bg-muted/60 px-1.5 py-px font-medium text-muted-foreground">
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
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(CHIP, 'tabular-nums border-border bg-muted/60 text-foreground', className)}
        >
          <Radio />
          {port.hostPort ?? port.port}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{port.label ? `${port.label} (${port.protocol})` : port.protocol}</TooltipContent>
    </Tooltip>
  );
}

/**
  * The one chip in the set that navigates. Ports, metrics and provider labels
  * are neutral facts, so a link that only differed by a hover colour was
  * indistinguishable from them — it carries a link hue and an underline instead.
  */
export function EndpointLink({ url, className }: { url: UrlInfo; className?: string }) {
  return (
    <Badge
      asChild
      variant="outline"
      className={cn(
        CHIP,
        'border-link/35 bg-link/10 font-medium text-link underline decoration-link/40 decoration-dotted underline-offset-2',
        'hover:border-link/60 hover:bg-link/15 hover:decoration-solid focus-visible:decoration-solid',
        className,
      )}
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
  const hint = entry.alert
    ? `${entry.label}: ${formatResource(entry.value, entry.unit)} — ${entry.alert.severity} threshold ${formatResource(entry.alert.threshold, entry.unit)}`
    : `${entry.label} · ${attribution ?? ''}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(CHIP, entry.alert ? tone.chip : 'border-border bg-muted/50 text-muted-foreground', className)}
        >
          {entry.metric === 'cpu' ? <Gauge className="opacity-70" /> : <Activity className="opacity-70" />}
          <span className="text-muted-foreground">{entry.short}</span>
          <span className="tabular-nums font-medium">{formatResource(entry.value, entry.unit)}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

/** A provider-declared metric, rendered according to its declared kind. */
export function MetricChip({ metric, className }: { metric: Metric; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(CHIP, 'border-border bg-muted/50', toneStyle(metric.tone).text, className)}
        >
          <span className="text-muted-foreground">{metric.label}</span>
          <span className="tabular-nums font-medium">{formatMetric(metric)}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{metric.label}</TooltipContent>
    </Tooltip>
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums flex items-center gap-1">
          <Clock3 className="size-3 text-muted-foreground" />
          {uptime}
        </span>
      </TooltipTrigger>
      <TooltipContent>{`Since ${service.since}`}</TooltipContent>
    </Tooltip>
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('min-w-0 truncate', className)}>{service.statusSummary}</span>
      </TooltipTrigger>
      <TooltipContent>{service.statusSummary}</TooltipContent>
    </Tooltip>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                'hidden items-center gap-1',
                actionClassName ?? 'sm:flex',
                service.lastAction.ok ? 'text-muted-foreground' : 'text-bad/80',
              )}
            >
              <ScrollText className="size-3" />
              {service.lastAction.label}
            </span>
          </TooltipTrigger>
          <TooltipContent>{`${service.lastAction.label}: ${service.lastAction.message}`}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{service.checking ? 'checking…' : formatAgo(service.lastCheckedAt)}</span>
        </TooltipTrigger>
        <TooltipContent>
          {service.lastCheckedAt ? `Last status check: ${service.lastCheckedAt}` : 'Never checked'}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
