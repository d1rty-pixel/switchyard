import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from './lib/api';
import {
  keys,
  useDebounced,
  useEventStream,
  useHotkeys,
  useMeta,
  usePersistentState,
  useReloadConfig,
  useReloadPreview,
  useRunAction,
  useServices,
  useStateCounts,
  useTicker,
} from './lib/hooks';
import { stateStyle } from './lib/status';
import type { ActionDescriptor, ActionRecord, ServiceSummary, ViewMode } from './lib/types';
import { TopBar } from './components/TopBar';
import { FilterBar, type Filters } from './components/FilterBar';
import { ServiceCard, SkeletonCard } from './components/ServiceCard';
import { ServiceTable, SkeletonTable } from './components/ServiceTable';
import { ServiceDrawer } from './components/ServiceDrawer';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog';
import {
  ApiDownState,
  ConfigWarnings,
  DisabledServices,
  GpuAccelWarning,
  InlineError,
  NoMatchesState,
  NoServicesState,
} from './components/EmptyState';
import { useToasts } from './components/Toasts';
import { hasGpuAcceleration } from './lib/gpu';
import { notify, notificationsSupported, requestNotificationPermission } from './lib/notify';
import type { ServiceState } from './lib/types';

const DEFAULT_FILTERS: Filters = { group: null, states: [], types: [], sort: 'group' };

/** States a desktop notification is worth interrupting the user for. */
const UNHEALTHY_STATES = new Set<ServiceState>(['failed', 'degraded', 'stopped']);

export default function App() {
  const client = useQueryClient();
  const toasts = useToasts();
  const searchInput = useRef<HTMLInputElement>(null);

  const meta = useMeta();
  const services = useServices();
  const runAction = useRunAction();
  const reloadConfig = useReloadConfig();
  const reloadPreview = useReloadPreview();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 120);
  const [filters, setFilters] = usePersistentState<Filters>('filters', DEFAULT_FILTERS);
  const [view, setView] = usePersistentState<ViewMode>('view', 'cards');
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<(ConfirmRequest & { run: () => void }) | null>(null);
  const [gpuWarningDismissed, setGpuWarningDismissed] = usePersistentState('gpuWarningDismissed', false);
  const [notificationsEnabled, setNotificationsEnabled] = usePersistentState('notificationsEnabled', false);

  const toggleNotifications = useCallback(() => {
    if (notificationsEnabled) {
      setNotificationsEnabled(false);
      return;
    }
    // An insecure origin can never grant permission, so pointing the user at
    // Chrome's site settings would send them somewhere with nothing to change.
    if (!notificationsSupported()) {
      toasts.push({
        tone: 'info',
        title: 'Notifications unavailable',
        message: 'Desktop notifications need a secure origin — open Switchyard over HTTPS or on localhost.',
      });
      return;
    }
    void requestNotificationPermission().then((permission) => {
      if (permission === 'granted') setNotificationsEnabled(true);
      else toasts.push({ tone: 'info', title: 'Notifications blocked', message: 'Allow notifications for this site to enable them.' });
    });
  }, [notificationsEnabled, setNotificationsEnabled, toasts]);

  // Keeps relative timestamps honest. Every 20 s, not every second: the labels
  // are coarse (see formatAgo), and re-rendering the grid once a second made the
  // cards visibly reflow as text widths changed.
  useTicker(20_000);

  // Actions started in this tab; used to avoid double-reporting an action that
  // already produced a toast with full command output.
  const localRuns = useRef(new Set<string>());

  // Actions where our own mutate() failed on a self-collision (see
  // isSelfCollision) — the request that actually started the action was lost
  // to a dropped connection, so no local success/error toast was shown. The
  // action:end event below still needs to report the real outcome; this set
  // just tells it not to blame that outcome on "started elsewhere".
  const retryRecoveries = useRef(new Set<string>());

  // Services with an action in flight from this tab. `service.busy` (server-
  // pushed) is the source of truth for disabling buttons, but it only updates
  // once the action:start event round-trips — a fast repeat click in that gap
  // reaches the server and bounces off its per-service lock as a genuine-looking
  // but self-inflicted "already running" conflict. Block repeats locally too.
  const pendingServices = useRef(new Set<string>());

  const stream = useEventStream(
    useCallback(
      (id: string, record: ActionRecord) => {
        // `action:end` arrives before the POST response, so the key is claimed
        // at dispatch time rather than derived from the record.
        const local = localRuns.current.delete(`${id}:${record.actionId}`);
        // Only consume a recovery key for an action this tab did not already
        // account for as a local run — the two sets are mutually exclusive.
        const recovered = !local && retryRecoveries.current.delete(`${id}:${record.actionId}`);
        const suffix = local
          ? ''
          : recovered
            ? ' (reconnected after a dropped connection)'
            : ' (started elsewhere)';

        // Desktop notification for *every* finished action, including the ones
        // this tab started. The toast below deliberately skips local runs
        // (dispatch already toasted them with full command output), but that
        // reasoning does not carry over to notifications: the whole point of a
        // desktop notification is to reach the user once they have looked away
        // from a start/stop/restart that takes time to finish.
        if (notificationsEnabled) {
          notify(
            `${id} · ${record.label}${record.ok ? '' : ' failed'}`,
            `${record.message}${suffix}`,
            `switchyard:action:${id}`,
          );
        }

        if (local) return;
        toasts.push({
          // A recovered self-collision is this tab's own result, same as a
          // normal onSuccess/onError — it earns the real success/error tone,
          // not the "info" used for genuinely foreign-triggered changes.
          tone: recovered ? (record.ok ? 'success' : 'error') : record.ok ? 'info' : 'error',
          title: `${id} · ${record.label}`,
          message: `${record.message}${suffix}`,
        });
      },
      [toasts, notificationsEnabled],
    ),
    useCallback(
      (previous: ServiceSummary | undefined, next: ServiceSummary) => {
        if (!notificationsEnabled || !previous) return;
        const wasUnhealthy = UNHEALTHY_STATES.has(previous.state);
        const isUnhealthy = UNHEALTHY_STATES.has(next.state);
        if (!wasUnhealthy && isUnhealthy) {
          notify(
            `${next.name} is ${next.state}`,
            next.statusSummary ?? 'Check the dashboard for details.',
            `switchyard:state:${next.id}`,
          );
        }
      },
      [notificationsEnabled],
    ),
  );

  const all = services.data ?? [];
  const stateCounts = useStateCounts(all);

  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of all) counts.set(service.group, (counts.get(service.group) ?? 0) + 1);
    return counts;
  }, [all]);

  const types = useMemo(() => {
    const seen = new Map<string, string>();
    for (const service of all) seen.set(service.type, service.providerLabel);
    return [...seen.entries()].map(([type, label]) => ({ type, label }));
  }, [all]);

  const groupOrder = useMemo(() => {
    const order = new Map<string, number>();
    (meta.data?.groups ?? []).forEach((group, index) => order.set(group.id, group.order ?? index));
    return order;
  }, [meta.data]);

  const groupNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const group of meta.data?.groups ?? []) names.set(group.id, group.name);
    return names;
  }, [meta.data]);

  const visible = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();

    const filtered = all.filter((service) => {
      if (filters.group && service.group !== filters.group) return false;
      if (filters.states.length > 0 && !filters.states.includes(service.state)) return false;
      if (filters.types.length > 0 && !filters.types.includes(service.type)) return false;
      if (!needle) return true;
      return matchesSearch(service, needle);
    });

    return filtered.sort((a, b) => compare(a, b, filters.sort, groupOrder));
  }, [all, filters, debouncedSearch, groupOrder]);

  const dispatch = useCallback(
    (service: ServiceSummary, action: ActionDescriptor) => {
      if (pendingServices.current.has(service.id)) return;
      pendingServices.current.add(service.id);
      localRuns.current.add(`${service.id}:${action.id}`);
      runAction.mutate(
        { id: service.id, action: action.id },
        {
          onSettled: () => {
            pendingServices.current.delete(service.id);
            // Always release the key: no local toast was shown for a self-
            // collision (see onError below either), so the eventual real
            // action:end event is what has to report the outcome — it must
            // find the key gone, or it suppresses itself right along with it.
            localRuns.current.delete(`${service.id}:${action.id}`);
          },
          onSuccess: (response) => {
            toasts.push({
              tone: response.ok ? 'success' : 'error',
              title: `${service.name} · ${action.label}`,
              message: response.message,
              details: buildDetails(response.output),
            });
          },
          onError: (error) => {
            // useRunAction retries once on a bare network error (Docker
            // reprogramming iptables for the very action being run briefly
            // cuts the path to this app — see hooks.ts). When that happens,
            // the retry lands after the original request already started the
            // action server-side, and conflicts with itself: a 409 whose
            // `busy` is this same action, not some other trigger. That's not
            // a real conflict for the user to act on — the action is already
            // under way — so stay quiet and let the real result arrive via
            // the action:end event instead of a misleading "already running"
            // toast for an action nobody but this tab tried to start twice.
            if (isSelfCollision(error, action.id)) {
              retryRecoveries.current.add(`${service.id}:${action.id}`);
              return;
            }
            const apiError = error as ApiError;
            toasts.push({
              tone: 'error',
              title: `${service.name} · ${action.label}`,
              message:
                apiError.code === 'conflict'
                  ? `${apiError.message} — wait for it to finish.`
                  : apiError.message,
            });
          },
        },
      );
    },
    [runAction, toasts],
  );

  const requestAction = useCallback(
    (service: ServiceSummary, action: ActionDescriptor) => {
      if (!action.confirm) {
        dispatch(service, action);
        return;
      }
      setConfirm({
        title: `${action.label} “${service.name}”?`,
        body:
          action.kind === 'danger'
            ? 'This interrupts the running service. Anything depending on it will lose its connection.'
            : 'This runs a state-changing action against the service.',
        confirmLabel: action.label,
        destructive: action.kind === 'danger',
        detail: action.description,
        run: () => dispatch(service, action),
      });
    },
    [dispatch],
  );

  const applyReload = useCallback(() => {
    reloadConfig.mutate(undefined, {
      onSuccess: (result) =>
        toasts.push({
          tone: 'info',
          title: 'Configuration reloaded',
          message: `${result.services} service(s) from ${result.path}`,
        }),
      onError: (error) =>
        toasts.push({ tone: 'error', title: 'Reload failed', message: (error as ApiError).message }),
    });
  }, [reloadConfig, toasts]);

  const requestReload = useCallback(() => {
    reloadPreview.mutate(undefined, {
      onSuccess: (preview) => {
        const { diff } = preview;
        if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
          toasts.push({ tone: 'info', title: 'Nothing to reload', message: 'Configuration on disk is unchanged.' });
          return;
        }
        setConfirm({
          title: 'Reload configuration?',
          body: `${preview.services} service(s) from ${preview.path}.`,
          confirmLabel: 'Reload',
          detail: formatDiff(diff),
          run: applyReload,
        });
      },
      onError: (error) =>
        toasts.push({ tone: 'error', title: 'Could not preview reload', message: (error as ApiError).message }),
    });
  }, [reloadPreview, toasts, applyReload]);

  useHotkeys({
    search: () => searchInput.current?.focus(),
    escape: () => {
      if (confirm) setConfirm(null);
      else if (openId) setOpenId(null);
    },
  });

  const clearFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setSearch('');
  };

  const apiDown = services.isError && (services.error as ApiError)?.status === 0;

  return (
    <div className="min-h-screen pb-16">
      <TopBar
        ref={searchInput}
        total={all.length}
        counts={stateCounts}
        stream={stream}
        search={search}
        onSearch={setSearch}
        view={view}
        onView={setView}
        reloading={reloadConfig.isPending || reloadPreview.isPending}
        configPath={meta.data?.configPath}
        version={meta.data?.app.version}
        onReload={requestReload}
        notificationsEnabled={notificationsEnabled}
        onToggleNotifications={toggleNotifications}
      />

      {all.length > 0 && (
        <div className="border-b border-line/50 bg-base-2/40">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            groups={meta.data?.groups ?? []}
            groupCounts={groupCounts}
            stateCounts={stateCounts}
            types={types}
            total={all.length}
            visible={visible.length}
          />
        </div>
      )}

      <main className="mx-auto max-w-[110rem] px-4 pt-5 sm:px-6">
        {!hasGpuAcceleration() && (
          <GpuAccelWarning dismissed={gpuWarningDismissed} onDismiss={() => setGpuWarningDismissed(true)} />
        )}
        {meta.data && <ConfigWarnings warnings={meta.data.configWarnings} />}
        {/* On a failed first load there's no service list yet, so `all` is
            empty and NoServicesState below covers the message space —
            showing this too would be a redundant, more cryptic "500
            Internal Server Error" next to it. A failed refetch that still
            has prior data is a real problem worth surfacing here. */}
        {services.isError && !apiDown && all.length > 0 && (
          <InlineError message={(services.error as Error).message} />
        )}

        {apiDown && (
          <ApiDownState
            message={(services.error as ApiError).message}
            onRetry={() => client.invalidateQueries({ queryKey: keys.services })}
          />
        )}

        {!apiDown && services.isPending &&
          (view === 'table' ? (
            <SkeletonTable />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-3.5">
              {Array.from({ length: 6 }, (_, index) => (
                <SkeletonCard key={index} delay={index * 90} />
              ))}
            </div>
          ))}

        {!apiDown && !services.isPending && all.length === 0 && (
          <NoServicesState configPath={meta.data?.configPath} />
        )}

        {!apiDown && all.length > 0 && visible.length === 0 && <NoMatchesState onClear={clearFilters} />}

        {visible.length > 0 &&
          (view === 'table' ? (
            <ServiceTable
              services={visible}
              groupNames={groupNames}
              onOpen={(service) => setOpenId(service.id)}
              onRunAction={requestAction}
            />
          ) : (
            // No AnimatePresence: cards unmount as soon as a filter excludes them.
            // Enter animation and layout transitions live on the card itself.
            <div className="grid grid-cols-[repeat(auto-fill,minmax(21rem,1fr))] gap-3.5">
              {visible.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  onOpen={() => setOpenId(service.id)}
                  onRunAction={requestAction}
                />
              ))}
            </div>
          ))}
      </main>

      {meta.data && <DisabledServices services={meta.data.disabledServices} />}

      <ServiceDrawer serviceId={openId} onClose={() => setOpenId(null)} onRunAction={requestAction} />

      <ConfirmDialog
        request={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
      />
    </div>
  );
}

function matchesSearch(service: ServiceSummary, needle: string): boolean {
  const haystack = [
    service.name,
    service.id,
    service.description ?? '',
    service.type,
    service.providerLabel,
    service.group,
    service.state,
    ...service.tags,
    ...service.ports.map((port) => String(port.hostPort ?? port.port)),
    ...service.urls.map((url) => url.url),
  ]
    .join(' ')
    .toLowerCase();
  return needle.split(/\s+/).every((term) => haystack.includes(term));
}

function compare(
  a: ServiceSummary,
  b: ServiceSummary,
  sort: Filters['sort'],
  groupOrder: Map<string, number>,
): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'status': {
      const delta = stateStyle(a.state).severity - stateStyle(b.state).severity;
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    }
    case 'recent': {
      const left = a.lastAction ? Date.parse(a.lastAction.startedAt) : 0;
      const right = b.lastAction ? Date.parse(b.lastAction.startedAt) : 0;
      return right - left || a.name.localeCompare(b.name);
    }
    case 'group':
    default: {
      const groupDelta =
        (groupOrder.get(a.group) ?? 500) - (groupOrder.get(b.group) ?? 500) || a.group.localeCompare(b.group);
      if (groupDelta !== 0) return groupDelta;
      const orderDelta = (a.order ?? 500) - (b.order ?? 500);
      return orderDelta !== 0 ? orderDelta : a.name.localeCompare(b.name);
    }
  }
}

function formatDiff(diff: { added: string[]; removed: string[]; changed: string[]; unchanged: number }): string {
  const lines: string[] = [];
  for (const id of diff.added) lines.push(`+ ${id}`);
  for (const id of diff.removed) lines.push(`- ${id}`);
  for (const id of diff.changed) lines.push(`~ ${id}`);
  if (diff.unchanged > 0) lines.push(`  ${diff.unchanged} unchanged`);
  return lines.join('\n');
}

/**
 * True if `error` is a 409 conflict whose `busy` details name the very
 * action we just dispatched — i.e. our own network-error retry (see
 * useRunAction) racing the request it retried, not a conflict with some
 * separately triggered run.
 */
function isSelfCollision(error: unknown, actionId: string): boolean {
  if (!(error instanceof ApiError) || error.code !== 'conflict') return false;
  const busy = (error.details as { busy?: { actionId?: string } } | undefined)?.busy;
  return busy?.actionId === actionId;
}

function buildDetails(output?: { argv?: string[]; stdout?: string; stderr?: string; exitCode?: number | null }): string | undefined {
  if (!output) return undefined;
  const parts: string[] = [];
  if (output.argv) parts.push(`$ ${output.argv.join(' ')}`);
  if (output.exitCode !== undefined && output.exitCode !== null) parts.push(`exit ${output.exitCode}`);
  if (output.stdout?.trim()) parts.push(output.stdout.trim());
  if (output.stderr?.trim()) parts.push(output.stderr.trim());
  const text = parts.join('\n');
  return text.trim() ? text : undefined;
}
