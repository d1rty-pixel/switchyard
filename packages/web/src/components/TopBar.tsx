import { Bell, BellOff, LayoutGrid, Loader2, RadioTower, RefreshCw, Search, Table2, X } from 'lucide-react';
import { forwardRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { Logo, Wordmark } from './Logo';
import { StateDistribution } from './StatusIndicator';
import { formatAgo } from '@/lib/format';
import type { StreamState } from '@/lib/hooks';
import type { ViewMode } from '@/lib/types';

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
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[110rem] flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Logo className="size-9" />
          <div className="leading-tight">
            <Wordmark className="text-[16px]" />
            <p className="text-[11.5px] text-muted-foreground" title={configPath}>
              {version ? `v${version}` : 'local control panel'}
            </p>
          </div>
        </div>

        <div className="order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-card/60 px-2.5 py-1.5 transition-colors focus-within:border-primary/40">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              ref={searchRef}
              value={search}
              onChange={(event) => onSearch(event.target.value)}
              placeholder="Search services, tags, ports…"
              aria-label="Search services"
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-[14px] text-foreground shadow-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
            />
            {search ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => onSearch('')}
                aria-label="Clear search"
                className="text-muted-foreground hover:bg-transparent hover:text-foreground"
              >
                <X />
              </Button>
            ) : (
              <kbd className="hidden rounded border border-border bg-popover px-1.5 py-px text-[11px] text-muted-foreground sm:block">
                /
              </kbd>
            )}
          </div>
        </div>

        <div className="order-2 ml-auto flex items-center gap-3 sm:order-3">
          <div className="hidden w-40 flex-col gap-1 md:flex">
            <div className="flex items-baseline justify-between text-[11.5px] text-muted-foreground">
              <span className="tabular-nums">
                <span className="font-semibold text-foreground">{running}</span>/{total} up
              </span>
              {unhealthy > 0 && <span className="tabular-nums text-amber-500">{unhealthy} need attention</span>}
            </div>
            <StateDistribution counts={counts} total={total} />
          </div>

          <StreamIndicator stream={stream} />

          <Button
            variant="outline"
            size="icon"
            onClick={onToggleNotifications}
            aria-pressed={notificationsEnabled}
            title={
              notificationsEnabled
                ? 'Desktop notifications on for every action and service change — click to turn off'
                : 'Get a desktop notification when an action finishes or a service goes down'
            }
            className={cn(
              'rounded-xl border',
              notificationsEnabled
                ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-500'
                : 'border-border bg-card/60 text-muted-foreground hover:text-foreground',
            )}
          >
            {notificationsEnabled ? <Bell /> : <BellOff />}
          </Button>

          <ToggleGroup
            type="single"
            value={view}
            // Radix reports "" when the pressed item is toggled off; there is no
            // third view, so that click keeps the current one.
            onValueChange={(next) => next && onView(next as ViewMode)}
            className="rounded-xl border border-border bg-card/60 p-0.5"
          >
            <ViewToggle value="cards" label="Card view">
              <LayoutGrid className="size-3.5" />
            </ViewToggle>
            <ViewToggle value="table" label="Table view">
              <Table2 className="size-3.5" />
            </ViewToggle>
          </ToggleGroup>

          <Button
            variant="outline"
            onClick={onReload}
            title="Reload switchyard.yaml from disk"
            className="rounded-xl border-border bg-card/60 text-[13px] text-muted-foreground hover:border-primary/40 hover:text-primary"
          >
            {reloading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            <span className="hidden sm:inline">Reload config</span>
          </Button>
        </div>
      </div>
    </header>
  );
});

function StreamIndicator({ stream }: { stream: StreamState }) {
  return (
    <Badge
      variant="outline"
      title={
        stream.connected
          ? `Live event stream connected · last event ${formatAgo(
              stream.lastEventAt ? new Date(stream.lastEventAt).toISOString() : null,
            )}`
          : 'Event stream disconnected — falling back to polling'
      }
      className={cn(
        'h-auto gap-1.5 rounded-xl border px-2 py-1.5 text-[12px]',
        stream.connected
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
          : 'border-amber-500/30 bg-amber-500/10 text-amber-500',
      )}
    >
      <RadioTower className={cn('size-3.5!', stream.connected && 'animate-pulse')} />
      <span className="hidden sm:inline">{stream.connected ? 'live' : 'offline'}</span>
    </Badge>
  );
}

function ViewToggle({ value, label, children }: { value: ViewMode; label: string; children: React.ReactNode }) {
  return (
    <ToggleGroupItem
      value={value}
      title={label}
      aria-label={label}
      className="size-auto rounded-lg border-0 bg-transparent p-1.5 text-muted-foreground hover:text-foreground data-[state=on]:bg-secondary data-[state=on]:text-foreground"
    >
      {children}
    </ToggleGroupItem>
  );
}
