import { AlertTriangle, Gauge } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { iconFor } from '@/lib/icons';
import { alertTone, resourceEntries } from '@/lib/resources';
import { formatResource } from '@/lib/format';
import { Callout } from './Callout';
import {
  ActivityLine,
  EndpointLink,
  LastCheckedInfo,
  MetricChip,
  PortChip,
  ProviderChip,
  ResourceChip,
  UptimeLabel,
} from './ServiceChips';
import { StatusBadge } from './StatusIndicator';
import { ActionRow } from './ActionControls';
import type { ActionDescriptor, ServiceSummary } from '@/lib/types';

export interface ServiceCardProps {
  service: ServiceSummary;
  onOpen: () => void;
  onRunAction: (service: ServiceSummary, action: ActionDescriptor) => void;
}

export function ServiceCard({ service, onOpen, onRunAction }: ServiceCardProps) {
  const Icon = iconFor(service.icon, service.type);
  const primaryUrl = service.urls.find((url) => url.primary) ?? service.urls[0];
  const highlights = service.metrics.filter((metric) => metric.highlight).slice(0, 3);
  const warning = service.warnings[0] ?? service.errors[0];
  // CPU and memory on the card, the rest in the drawer: two numbers is what fits
  // next to the ports without turning the card into a monitoring console.
  const resources = service.resources
    ? resourceEntries(service.resources, service.alerts).filter(
        (entry) => entry.metric === 'cpu' || entry.metric === 'memory' || entry.alert,
      )
    : [];
  const alert = service.alerts[0];
  const extraProblems = service.warnings.length + service.errors.length - 1;

  return (
    <Card
      className={cn(
        'animate-in fade-in slide-in-from-bottom-1',
        // No hover lift, shadow or card change — the card stays put; the only
        // hover feedback is on the interactive elements themselves.
        // `overflow-visible`: the action menu is portalled and must escape
        // the card's bounds.
        'group relative gap-0 overflow-visible py-0',
        service.busy && 'border-primary/30',
      )}
    >
      <div className="flex items-start gap-3 p-4 pl-5">
        <Button
          variant="outline"
          size="icon-lg"
          onClick={onOpen}
          aria-label={`Open ${service.name}`}
          className="shrink-0 rounded-xl border-border bg-popover/80 text-muted-foreground hover:border-primary/40 hover:text-primary"
        >
          <Icon className="size-4.5" />
        </Button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 text-left">
              <h3 className="truncate text-[15px] font-semibold leading-tight text-foreground transition-colors group-hover:text-primary">
                {service.name}
              </h3>
              <ProviderChip service={service} className="mt-1" />
            </button>
            <StatusBadge state={service.state} />
          </div>

          {service.description && (
            <p className="mt-2 line-clamp-2 text-[13.5px] leading-relaxed text-muted-foreground">{service.description}</p>
          )}

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
            <ActivityLine service={service} />
            {service.since && <UptimeLabel service={service} />}
          </p>
        </div>
      </div>

      {(highlights.length > 0 || resources.length > 0 || service.ports.length > 0 || primaryUrl) && (
        <CardContent className="flex flex-wrap items-center gap-1.5 px-4 pb-3 pl-5">
          {resources.map((entry) => (
            <ResourceChip key={entry.metric} entry={entry} attribution={service.resources?.attribution} />
          ))}
          {highlights.map((metric) => (
            <MetricChip key={metric.label} metric={metric} />
          ))}
          {service.ports.slice(0, 3).map((port) => (
            <PortChip key={`${port.protocol}-${port.hostPort ?? port.port}`} port={port} />
          ))}
          {primaryUrl && <EndpointLink url={primaryUrl} />}
        </CardContent>
      )}

      {/* Resource alerts get their own row, above the provider warnings: they
          describe load rather than a broken service, and the two would be
          indistinguishable in one list. */}
      {alert && (
        <Callout
          as="button"
          tone={alertTone(alert.severity)}
          icon={Gauge}
          onClick={onOpen}
          title={`Since ${alert.activatedAt}`}
          className="mx-4 mb-3 ml-5 text-[12.5px]"
        >
          {alert.label} {alert.severity} · {formatResource(alert.value, alert.unit)} over{' '}
          {formatResource(alert.threshold, alert.unit)}
          {alert.stale && ' (no fresh samples)'}
          {service.alerts.length > 1 && (
            <span className="ml-1 underline decoration-dotted">+{service.alerts.length - 1} more</span>
          )}
        </Callout>
      )}

      {warning && (
        <Callout tone="warn" icon={AlertTriangle} className="mx-4 mb-3 ml-5 text-[12.5px]">
          {warning}
          {extraProblems > 0 && (
            <button type="button" onClick={onOpen} className="ml-1 underline decoration-dotted hover:text-foreground">
              +{extraProblems} more
            </button>
          )}
        </Callout>
      )}

      <CardFooter className="mt-auto flex items-center justify-between gap-2 border-t border-border/70 px-4 py-2.5 pl-5">
        <ActionRow service={service} onRun={(action) => onRunAction(service, action)} />
        <div className="flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          <LastCheckedInfo service={service} />
        </div>
        </CardFooter>
    </Card>
  );
}

export function SkeletonCard({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="animate-pulse rounded-xl border bg-card p-4"
      style={{ animationDelay: `${delay}ms` }}
      aria-hidden
    >
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-xl bg-popover" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/3 rounded bg-popover" />
          <div className="h-2.5 w-1/5 rounded bg-popover/70" />
          <div className="h-2.5 w-4/5 rounded bg-popover/50" />
        </div>
        <div className="h-5 w-16 rounded-full bg-popover" />
      </div>
      <div className="mt-4 flex gap-2">
        <div className="h-6 w-16 rounded-lg bg-popover" />
        <div className="h-6 w-16 rounded-lg bg-popover/70" />
      </div>
    </div>
  );
}
