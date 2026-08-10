import { AlertTriangle, ArrowUpRight, Clock3, Radio, ScrollText } from 'lucide-react';
import clsx from 'clsx';
import { iconFor } from '../lib/icons';
import { stateStyle } from '../lib/status';
import { formatAgo, formatUptime } from '../lib/format';
import { StatusBadge, StatusIndicator } from './StatusIndicator';
import { ActionRow } from './ActionControls';
import type { ActionDescriptor, ServiceSummary } from '../lib/types';

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
    <div className="glass card-sheen overflow-hidden rounded-[var(--radius-card)]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[56rem] border-collapse text-left">
          <thead>
            <tr className="text-[11.5px] uppercase tracking-wider text-faint">
              <Th className="pl-5">Service</Th>
              <Th className="w-px whitespace-nowrap">State</Th>
              <Th className="hidden lg:table-cell">Detail</Th>
              <Th className="hidden w-px whitespace-nowrap xl:table-cell">Group</Th>
              <Th className="hidden w-px whitespace-nowrap md:table-cell">Uptime</Th>
              <Th className="hidden lg:table-cell">Endpoints</Th>
              <Th className="w-px whitespace-nowrap text-right">Actions</Th>
              <Th className="hidden w-px whitespace-nowrap text-right sm:table-cell">Checked</Th>
            </tr>
          </thead>
          <tbody>
            {services.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                groupName={groupNames.get(service.group) ?? service.group}
                onOpen={() => onOpen(service)}
                onRunAction={(action) => onRunAction(service, action)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th scope="col" className={clsx('border-b border-line/70 px-3 py-2.5 font-medium', className)}>
      {children}
    </th>
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
  const uptime = formatUptime(service.since);
  const primaryUrl = service.urls.find((url) => url.primary) ?? service.urls[0];
  const warning = service.warnings[0] ?? service.errors[0];
  const extraWarnings = service.warnings.length + service.errors.length - 1;

  return (
    <tr
      className={clsx(
        'group border-b border-line-soft/50 align-middle transition-colors last:border-b-0 hover:bg-surface-2/40',
        service.busy && 'bg-signal/[0.04]',
      )}
    >
      {/* Name cell carries the state rail, mirroring the card's left edge. */}
      <td className="relative py-2.5 pl-5 pr-3">
        <span
          aria-hidden
          className="absolute inset-y-1.5 left-0 w-[2px] rounded-full"
          style={{
            background: style.color,
            boxShadow: `0 0 14px -2px ${style.color}`,
            opacity: service.state === 'stopped' ? 0.45 : 0.9,
          }}
        />
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted" />
          <button type="button" onClick={onOpen} className="min-w-0 text-left">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[14px] font-semibold text-ink transition-colors group-hover:text-signal">
                {service.name}
              </span>
              {warning && (
                // The tooltip lives on a wrapper: a `title` attribute on an SVG
                // element is not rendered as one.
                <span
                  className="shrink-0 text-st-degraded"
                  title={extraWarnings > 0 ? `${warning} (+${extraWarnings} more)` : warning}
                >
                  <AlertTriangle className="size-3.5" />
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
              <span className="rounded border border-line-soft bg-surface-2/60 px-1.5 py-px font-medium text-muted">
                {service.providerLabel}
              </span>
              {service.children && (
                <span className="num">
                  {service.children.running}/{service.children.total} containers
                </span>
              )}
            </span>
          </button>
        </div>
      </td>

      <td className="whitespace-nowrap px-3 py-2.5">
        <StatusBadge state={service.state} />
      </td>

      <td className="hidden max-w-[22rem] px-3 py-2.5 text-[12.5px] text-ink-2 lg:table-cell">
        {service.busy ? (
          <span className="flex items-center gap-1.5 text-signal">
            <StatusIndicator state={service.state} size={9} />
            {service.busy.label} running…
          </span>
        ) : (
          <span className="block truncate" title={service.statusSummary ?? service.description}>
            {service.statusSummary ?? service.description ?? '—'}
          </span>
        )}
      </td>

      <td className="hidden whitespace-nowrap px-3 py-2.5 text-[12.5px] text-muted xl:table-cell">{groupName}</td>

      <td className="hidden whitespace-nowrap px-3 py-2.5 text-[12.5px] text-muted md:table-cell">
        {uptime ? (
          <span className="num flex items-center gap-1" title={`Since ${service.since}`}>
            <Clock3 className="size-3 text-faint" />
            {uptime}
          </span>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>

      <td className="hidden px-3 py-2.5 lg:table-cell">
        <div className="flex flex-wrap items-center gap-1.5">
          {service.ports.slice(0, 3).map((port) => (
            <span
              key={`${port.protocol}-${port.hostPort ?? port.port}`}
              className="num inline-flex items-center gap-1 rounded-md border border-route/25 bg-route/10 px-1.5 py-0.5 text-[12px] text-route"
              title={port.label ? `${port.label} (${port.protocol})` : port.protocol}
            >
              <Radio className="size-3" />
              {port.hostPort ?? port.port}
            </span>
          ))}
          {primaryUrl && (
            <a
              href={primaryUrl.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-line-soft bg-surface-2/50 px-1.5 py-0.5 text-[12px] text-ink-2 transition-colors hover:border-signal/40 hover:text-signal"
            >
              {primaryUrl.label}
              <ArrowUpRight className="size-3" />
            </a>
          )}
          {service.ports.length === 0 && !primaryUrl && <span className="text-[12.5px] text-faint">—</span>}
        </div>
      </td>

      <td className="whitespace-nowrap px-3 py-2.5">
        <div className="flex justify-end">
          <ActionRow
            service={service}
            onRun={onRunAction}
            inlineLimit={2}
            compact
            wrap={false}
            prioritiseEnabled
          />
        </div>
      </td>

      <td className="hidden whitespace-nowrap px-3 py-2.5 text-right text-[11.5px] text-faint sm:table-cell">
        <span className="flex items-center justify-end gap-2">
          {service.lastAction && (
            <span
              title={`${service.lastAction.label}: ${service.lastAction.message}`}
              className={clsx(
                'hidden items-center gap-1 xl:flex',
                service.lastAction.ok ? 'text-faint' : 'text-st-failed/80',
              )}
            >
              <ScrollText className="size-3" />
              {service.lastAction.label}
            </span>
          )}
          <span title={service.lastCheckedAt ? `Last status check: ${service.lastCheckedAt}` : 'Never checked'}>
            {service.checking ? 'checking…' : formatAgo(service.lastCheckedAt)}
          </span>
        </span>
      </td>
    </tr>
  );
}

export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="glass overflow-hidden rounded-[var(--radius-card)]" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="animate-shimmer flex items-center gap-3 border-b border-line-soft/50 px-5 py-3 last:border-b-0"
          style={{ animationDelay: `${index * 90}ms` }}
        >
          <div className="size-4 rounded bg-surface-2" />
          <div className="h-3 w-40 rounded bg-surface-2" />
          <div className="h-5 w-20 rounded-full bg-surface-2/70" />
          <div className="h-2.5 flex-1 rounded bg-surface-2/40" />
          <div className="h-6 w-16 rounded-lg bg-surface-2/70" />
        </div>
      ))}
    </div>
  );
}
