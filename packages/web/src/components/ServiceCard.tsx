import { AlertTriangle, ArrowUpRight, Clock3, Radio, ScrollText } from 'lucide-react';
import clsx from 'clsx';
import { iconFor } from '../lib/icons';
import { stateStyle } from '../lib/status';
import { formatAgo, formatMetric, formatUptime } from '../lib/format';
import { StatusBadge, StatusIndicator } from './StatusIndicator';
import { ActionRow } from './ActionControls';
import type { ActionDescriptor, ServiceSummary } from '../lib/types';

export interface ServiceCardProps {
  service: ServiceSummary;
  density: 'compact' | 'comfortable';
  onOpen: () => void;
  onRunAction: (service: ServiceSummary, action: ActionDescriptor) => void;
}

export function ServiceCard({ service, density, onOpen, onRunAction }: ServiceCardProps) {
  const style = stateStyle(service.state);
  const Icon = iconFor(service.icon, service.type);
  const uptime = formatUptime(service.since);
  const compact = density === 'compact';
  const primaryUrl = service.urls.find((url) => url.primary) ?? service.urls[0];
  const highlights = service.metrics.filter((metric) => metric.highlight).slice(0, 3);
  const warning = service.warnings[0] ?? service.errors[0];

  return (
    <article
      className={clsx(
        'animate-rise',
        // No hover lift, shadow or surface change — the card stays put; the only
        // hover feedback is on the interactive elements themselves.
        'card-sheen glass group relative flex flex-col rounded-[var(--radius-card)]',
        service.busy && 'border-signal/30',
      )}
      style={{ ['--state' as string]: style.color }}
    >
      {/* State rail: the fastest signal when scanning a full grid. */}
      <span
        aria-hidden
        className="absolute inset-y-3 left-0 w-[2px] rounded-full transition-colors duration-300"
        style={{
          background: style.color,
          boxShadow: `0 0 14px -2px ${style.color}`,
          opacity: service.state === 'stopped' ? 0.45 : 0.9,
        }}
      />

      <div className={clsx('flex items-start gap-3', compact ? 'p-3 pl-4' : 'p-4 pl-5')}>
        <button
          type="button"
          onClick={onOpen}
          className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-2/80 text-ink-2 transition-colors hover:border-signal/40 hover:text-signal"
          aria-label={`Open ${service.name}`}
        >
          <Icon className="size-4.5" />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <button type="button" onClick={onOpen} className="min-w-0 text-left">
              <h3 className="truncate text-[15px] font-semibold leading-tight text-ink transition-colors group-hover:text-signal">
                {service.name}
              </h3>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                <span className="rounded border border-line-soft bg-surface-2/60 px-1.5 py-px font-medium text-muted">
                  {service.providerLabel}
                </span>
                {service.children && (
                  <span className="num">
                    {service.children.running}/{service.children.total} containers
                  </span>
                )}
              </p>
            </button>
            <StatusBadge state={service.state} />
          </div>

          {!compact && service.description && (
            <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-ink-2">{service.description}</p>
          )}

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
            {service.busy ? (
              <span className="flex items-center gap-1.5 text-signal">
                <StatusIndicator state={service.state} size={9} />
                {service.busy.label} running…
              </span>
            ) : (
              service.statusSummary && (
                <span className="min-w-0 truncate" title={service.statusSummary}>
                  {service.statusSummary}
                </span>
              )
            )}
            {uptime && (
              <span className="num flex items-center gap-1" title={`Since ${service.since}`}>
                <Clock3 className="size-3 text-faint" />
                {uptime}
              </span>
            )}
          </p>
        </div>
      </div>

      {(highlights.length > 0 || service.ports.length > 0 || primaryUrl) && (
        <div className={clsx('flex flex-wrap items-center gap-1.5 px-4 pb-3 pl-5', compact && 'px-3 pb-2.5 pl-4')}>
          {highlights.map((metric) => (
            <span
              key={metric.label}
              title={metric.label}
              className={clsx(
                'inline-flex items-center gap-1 rounded-md border border-line-soft bg-surface-2/50 px-1.5 py-0.5 text-[12px]',
                metric.tone === 'good' && 'text-st-running/90',
                metric.tone === 'warn' && 'text-st-degraded/90',
                metric.tone === 'bad' && 'text-st-failed/90',
                (!metric.tone || metric.tone === 'default') && 'text-ink-2',
              )}
            >
              <span className="text-faint">{metric.label}</span>
              <span className="num font-medium">{formatMetric(metric)}</span>
            </span>
          ))}

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
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-md border border-line-soft bg-surface-2/50 px-1.5 py-0.5 text-[12px] text-ink-2 transition-colors hover:border-signal/40 hover:text-signal"
            >
              {primaryUrl.label}
              <ArrowUpRight className="size-3" />
            </a>
          )}
        </div>
      )}

      {warning && (
        <div className="mx-4 mb-3 ml-5 flex items-start gap-2 rounded-lg border border-st-degraded/25 bg-st-degraded/[0.07] px-2.5 py-1.5 text-[11.5px] leading-relaxed text-st-degraded">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">
            {warning}
            {service.warnings.length + service.errors.length > 1 && (
              <button type="button" onClick={onOpen} className="ml-1 underline decoration-dotted hover:text-ink">
                +{service.warnings.length + service.errors.length - 1} more
              </button>
            )}
          </span>
        </div>
      )}

      <div
        className={clsx(
          'mt-auto flex items-center justify-between gap-2 border-t border-line-soft/70 px-4 py-2.5 pl-5',
          compact && 'px-3 py-2 pl-4',
        )}
      >
        <ActionRow service={service} onRun={(action) => onRunAction(service, action)} compact={compact} />
        <div className="flex shrink-0 items-center gap-2 text-[10.5px] text-faint">
          {service.lastAction && (
            <span
              title={`${service.lastAction.label}: ${service.lastAction.message}`}
              className={clsx(
                'hidden items-center gap-1 sm:flex',
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
        </div>
      </div>
    </article>
  );
}

export function SkeletonCard({ delay = 0 }: { delay?: number }) {
  return (
    <div
      className="glass animate-shimmer rounded-[var(--radius-card)] p-4"
      style={{ animationDelay: `${delay}ms` }}
      aria-hidden
    >
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-xl bg-surface-2" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/3 rounded bg-surface-2" />
          <div className="h-2.5 w-1/5 rounded bg-surface-2/70" />
          <div className="h-2.5 w-4/5 rounded bg-surface-2/50" />
        </div>
        <div className="h-5 w-16 rounded-full bg-surface-2" />
      </div>
      <div className="mt-4 flex gap-2">
        <div className="h-6 w-16 rounded-lg bg-surface-2" />
        <div className="h-6 w-16 rounded-lg bg-surface-2/70" />
      </div>
    </div>
  );
}
