import { Bell, BellOff, LayoutGrid, Loader2, RadioTower, RefreshCw, Search, Table2, X } from 'lucide-react';
import clsx from 'clsx';
import { forwardRef } from 'react';
import { Logo, Wordmark } from './Logo';
import { StateDistribution } from './StatusIndicator';
import { formatAgo } from '../lib/format';
import type { StreamState } from '../lib/hooks';
import type { ViewMode } from '../lib/types';

export interface TopBarProps {
  total: number;
  counts: Map<string, number>;
  stream: StreamState;
  search: string;
  onSearch: (value: string) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  onReload: () => void;
  reloading: boolean;
  configPath?: string;
  version?: string;
  notificationsEnabled: boolean;
  onToggleNotifications: () => void;
}

export const TopBar = forwardRef<HTMLInputElement, TopBarProps>(function TopBar(
  {
    total,
    counts,
    stream,
    search,
    onSearch,
    view,
    onView,
    onReload,
    reloading,
    configPath,
    version,
    notificationsEnabled,
    onToggleNotifications,
  },
  searchRef,
) {
  const running = counts.get('running') ?? 0;
  const unhealthy = (counts.get('failed') ?? 0) + (counts.get('degraded') ?? 0);

  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-base/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo className="size-9" />
          <div className="leading-tight">
            <Wordmark className="text-[16px]" />
            <p className="text-[11.5px] text-faint" title={configPath}>
              {version ? `v${version}` : 'local control panel'}
            </p>
          </div>
        </div>

        <div className="order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1">
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface/60 px-2.5 py-1.5 transition-colors focus-within:border-signal/40">
            <Search className="size-3.5 shrink-0 text-faint" />
            <input
              ref={searchRef}
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search services, tags, ports…"
              aria-label="Search services"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => onSearch('')}
                aria-label="Clear search"
                className="rounded p-0.5 text-faint hover:text-ink"
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <kbd className="hidden rounded border border-line bg-surface-2 px-1.5 py-px text-[11px] text-faint sm:block">
                /
              </kbd>
            )}
          </div>
        </div>

        <div className="order-2 ml-auto flex items-center gap-3 sm:order-3">
          <div className="hidden w-40 flex-col gap-1 md:flex">
            <div className="flex items-baseline justify-between text-[11.5px] text-faint">
              <span className="num">
                <span className="font-semibold text-ink">{running}</span>/{total} up
              </span>
              {unhealthy > 0 && <span className="num text-st-degraded">{unhealthy} need attention</span>}
            </div>
            <StateDistribution counts={counts} total={total} />
          </div>

          <StreamIndicator stream={stream} />

          <button
            type="button"
            onClick={onToggleNotifications}
            aria-pressed={notificationsEnabled}
            title={
              notificationsEnabled
                ? 'Desktop notifications on for every action and service change — click to turn off'
                : 'Get a desktop notification when an action finishes or a service goes down'
            }
            className={clsx(
              'rounded-xl border p-1.5 transition-colors',
              notificationsEnabled
                ? 'border-signal/35 bg-signal/12 text-signal'
                : 'border-line bg-surface/60 text-muted hover:text-ink',
            )}
          >
            {notificationsEnabled ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
          </button>

          <div className="flex items-center rounded-xl border border-line bg-surface/60 p-0.5">
            <IconButton active={view === 'cards'} onClick={() => onView('cards')} label="Card view">
              <LayoutGrid className="size-3.5" />
            </IconButton>
            <IconButton active={view === 'table'} onClick={() => onView('table')} label="Table view">
              <Table2 className="size-3.5" />
            </IconButton>
          </div>

          <button
            type="button"
            onClick={onReload}
            title="Reload switchyard.yaml from disk"
            className="flex items-center gap-1.5 rounded-xl border border-line bg-surface/60 px-2.5 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-signal/40 hover:text-signal"
          >
            {reloading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            <span className="hidden sm:inline">Reload config</span>
          </button>
        </div>
      </div>
    </header>
  );
});

function StreamIndicator({ stream }: { stream: StreamState }) {
  return (
    <span
      title={
        stream.connected
          ? `Live event stream connected · last event ${formatAgo(
              stream.lastEventAt ? new Date(stream.lastEventAt).toISOString() : null,
            )}`
          : 'Event stream disconnected — falling back to polling'
      }
      className={clsx(
        'flex items-center gap-1.5 rounded-xl border px-2 py-1.5 text-[12px] font-medium',
        stream.connected
          ? 'border-signal/30 bg-signal/10 text-signal'
          : 'border-st-degraded/30 bg-st-degraded/10 text-st-degraded',
      )}
    >
      <RadioTower className={clsx('size-3.5', stream.connected && 'animate-pip')} />
      <span className="hidden sm:inline">{stream.connected ? 'live' : 'offline'}</span>
    </span>
  );
}

function IconButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={clsx(
        'rounded-lg p-1.5 transition-colors',
        active ? 'bg-surface-3 text-ink' : 'text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
