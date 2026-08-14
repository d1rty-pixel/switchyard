import { AlertTriangle, Gauge } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { iconFor } from '@/lib/icons';
import { alertTone, resourceEntries } from '@/lib/resources';
import { stateStyle, toneStyle } from '@/lib/status';
import { formatResource } from '@/lib/format';
import {
  ActivityLine,
  EndpointLink,
  LastCheckedInfo,
  PortChip,
  ProviderChip,
  StateRail,
  UptimeLabel,
} from './ServiceChips';
import { StatusBadge } from './StatusIndicator';
import { ActionRow } from './ActionControls';
import type { ActionDescriptor, ServiceSummary } from '@/lib/types';

export interface ServiceTableProps {
  services: ServiceSummary[];
  /** Group id → display name, for the group column. */
  groupNames: Map<string, string>;
  onOpen: (service: ServiceSummary) => void;
  onRunAction: (service: ServiceSummary, action: ActionDescriptor) => void;
}

/**
 * Dense alternative to the card grid: one row per service, columns aligned so a
 * long list can be scanned down a single axis. The cards show the same facts,
 * but a card grid stops being scannable somewhere around thirty services —
 * that is what this view is for.
 *
 * The table scrolls horizontally rather than reflowing: comparing a column only
 * works while the columns stay in the same place. Secondary columns drop out at
 * narrow widths instead, so the scroll is a last resort.
 */
export function ServiceTable({ services, groupNames, onOpen, onRunAction }: ServiceTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table className="min-w-[56rem] border-collapse text-left">
        <TableHeader>
          <TableRow className="text-[11.5px] uppercase tracking-wider text-muted-foreground hover:bg-transparent [&>th]:border-b [&>th]:border-border/70">
            <Th className="pl-5">Service</Th>
            <Th className="w-px">State</Th>
            <Th className="hidden lg:table-cell">Detail</Th>
            <Th className="hidden w-px xl:table-cell">Group</Th>
            <Th className="hidden w-px md:table-cell">Uptime</Th>
            <Th className="hidden w-px md:table-cell">Load</Th>
            <Th className="hidden lg:table-cell">Endpoints</Th>
            <Th className="w-px text-right">Actions</Th>
            <Th className="hidden w-px text-right sm:table-cell">Checked</Th>
          </TableRow>
        </TableHeader>
        <TableBody>
          {services.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              groupName={groupNames.get(service.group) ?? service.group}
              onOpen={() => onOpen(service)}
              onRunAction={(action) => onRunAction(service, action)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <TableHead scope="col" className={cn('h-auto px-3 py-2.5 text-inherit', className)}>
      {children}
    </TableHead>
  );
}

function ServiceRow({
  service,
  groupName,
  onOpen,
  onRunAction,
}: {
  service: ServiceSummary;
  groupName: string;
  onOpen: () => void;
  onRunAction: (action: ActionDescriptor) => void;
}) {
  const style = stateStyle(service.state);
  const Icon = iconFor(service.icon, service.type);
  const primaryUrl = service.urls.find((url) => url.primary) ?? service.urls[0];
  const warning = service.warnings[0] ?? service.errors[0];
  const extraWarnings = service.warnings.length + service.errors.length - 1;
  const load = service.resources
    ? resourceEntries(service.resources, service.alerts).filter(
        (entry) => entry.metric === 'cpu' || entry.metric === 'memory',
      )
    : [];
  const alert = service.alerts[0];

  return (
    <TableRow
      className={cn('group border-border/50 align-middle hover:bg-popover/40', service.busy && 'bg-primary/[0.04]')}
    >
      {/* Name cell carries the state rail, mirroring the card's left edge. */}
      <TableCell className="relative py-2.5 pl-5 pr-3">
        <StateRail color={style.color} dimmed={service.state === 'stopped'} className="inset-y-1.5" />
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold text-foreground transition-colors group-hover:text-primary">
                {service.name}
              </span>
              {warning && (
                // The tooltip lives on a wrapper: a `title` attribute on an SVG
                // element is not rendered as one.
                <span
                  className="shrink-0 text-amber-500"
                  title={extraWarnings > 0 ? `${warning} (+${extraWarnings} more)` : warning}
                >
                  <AlertTriangle className="size-3.5" />
                </span>
              )}
              {alert && (
                <span
                  className={cn('shrink-0', toneStyle(alertTone(alert.severity)).text)}
                  title={
                    `${alert.label} ${alert.severity}: ${formatResource(alert.value, alert.unit)} over ` +
                    `${formatResource(alert.threshold, alert.unit)}` +
                    (service.alerts.length > 1 ? ` (+${service.alerts.length - 1} more)` : '')
                  }
                >
                  <Gauge className="size-3.5" />
                </span>
              )}
            </span>
            <ProviderChip service={service} />
          </button>
        </div>
      </TableCell>

      <TableCell className="px-3 py-2.5">
        <StatusBadge state={service.state} />
      </TableCell>

      <TableCell className="hidden max-w-[22rem] px-3 py-2.5 text-[12.5px] text-muted-foreground lg:table-cell">
        <ActivityLine service={service} className="block" />
        {!service.busy && !service.statusSummary && (
          <span className="block truncate" title={service.description}>
            {service.description ?? '—'}
          </span>
        )}
      </TableCell>

      <TableCell className="hidden px-3 py-2.5 text-[12.5px] text-muted-foreground xl:table-cell">{groupName}</TableCell>

      <TableCell className="hidden px-3 py-2.5 text-[12.5px] text-muted-foreground md:table-cell">
        <UptimeLabel service={service} />
      </TableCell>

      {/* CPU and memory only: the row has to stay one line, and the drawer has
          the full set including disk and network. */}
      <TableCell className="hidden px-3 py-2.5 text-[12.5px] md:table-cell">
        {load.length > 0 ? (
          <span className="flex items-center gap-2">
            {load.map((entry) => (
              <span
                key={entry.metric}
                title={`${entry.label} · ${service.resources?.attribution ?? ''}`}
                className={cn('tabular-nums', entry.alert ? toneStyle(alertTone(entry.alert.severity)).text : 'text-muted-foreground')}
              >
                <span className="text-muted-foreground">{entry.short} </span>
                {formatResource(entry.value, entry.unit)}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="hidden px-3 py-2.5 lg:table-cell">
        <div className="flex flex-wrap items-center gap-1.5">
          {service.ports.slice(0, 3).map((port) => (
            <PortChip key={`${port.protocol}-${port.hostPort ?? port.port}`} port={port} />
          ))}
          {primaryUrl && <EndpointLink url={primaryUrl} />}
          {service.ports.length === 0 && !primaryUrl && <span className="text-[12.5px] text-muted-foreground">—</span>}
        </div>
      </TableCell>

      <TableCell className="px-3 py-2.5">
        <div className="flex justify-end">
          <ActionRow service={service} onRun={onRunAction} inlineLimit={2} compact wrap={false} prioritiseEnabled />
        </div>
      </TableCell>

      <TableCell className="hidden px-3 py-2.5 text-right text-[11.5px] text-muted-foreground sm:table-cell">
        <span className="flex items-center justify-end gap-2">
          <LastCheckedInfo service={service} actionClassName="xl:flex" />
        </span>
      </TableCell>
    </TableRow>
  );
}

export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="animate-pulse flex items-center gap-3 border-b border-border/50 px-5 py-3 last:border-b-0"
          style={{ animationDelay: `${index * 90}ms` }}
        >
          <div className="size-4 rounded bg-popover" />
          <div className="h-3 w-40 rounded bg-popover" />
          <div className="h-5 w-20 rounded-full bg-popover/70" />
          <div className="h-2.5 flex-1 rounded bg-popover/40" />
          <div className="h-6 w-16 rounded-lg bg-popover/70" />
        </div>
      ))}
    </div>
  );
}
