import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { ActionRecord, ServiceDetail, ServiceSummary } from './types';

export const keys = {
  meta: ['meta'] as const,
  services: ['services'] as const,
  service: (id: string) => ['service', id] as const,
  logs: (id: string, tail: number) => ['logs', id, tail] as const,
};

export function useMeta() {
  return useQuery({ queryKey: keys.meta, queryFn: api.meta, staleTime: 60_000 });
}

export function useServices() {
  return useQuery({
    queryKey: keys.services,
    queryFn: api.services,
    // The SSE stream is the primary update path; this is the safety net for a
    // dropped stream or a tab that was suspended.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
  });
}

export function useServiceDetail(id: string | null) {
  return useQuery({
    queryKey: keys.service(id ?? '—'),
    queryFn: () => api.service(id as string),
    enabled: id !== null,
    staleTime: 1_000,
  });
}

export function useLogs(id: string | null, tail: number, enabled: boolean, autoRefresh: boolean) {
  return useQuery({
    queryKey: keys.logs(id ?? '—', tail),
    queryFn: () => api.logs(id as string, tail),
    enabled: id !== null && enabled,
    refetchInterval: autoRefresh ? 4_000 : false,
    staleTime: 1_000,
  });
}

/** Patch one service into the list cache and, if open, the detail cache. */
function patchService(client: QueryClient, service: ServiceSummary): void {
  client.setQueryData<ServiceSummary[]>(keys.services, (current) => {
    if (!current) return current;
    const index = current.findIndex((entry) => entry.id === service.id);
    if (index === -1) return [...current, service];
    const next = [...current];
    next[index] = service;
    return next;
  });

  client.setQueryData<ServiceDetail>(keys.service(service.id), (current) =>
    current ? { ...current, ...service } : current,
  );
}

export interface StreamState {
  connected: boolean;
  lastEventAt: number | null;
  reconnects: number;
}

/**
 * Subscribes to `/api/events` and keeps the React Query cache in sync.
 * `onAction` fires for every finished action, including ones started elsewhere.
 */
export function useEventStream(onAction?: (id: string, record: ActionRecord) => void): StreamState {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>({ connected: false, lastEventAt: null, reconnects: 0 });
  const actionHandler = useRef(onAction);
  actionHandler.current = onAction;

  useEffect(() => {
    const source = new EventSource('/api/events');
    let opened = false;

    const touch = () => setState((current) => ({ ...current, connected: true, lastEventAt: Date.now() }));

    source.onopen = () => {
      setState((current) => ({
        connected: true,
        lastEventAt: Date.now(),
        reconnects: opened ? current.reconnects + 1 : current.reconnects,
      }));
      opened = true;
    };

    source.onerror = () => setState((current) => ({ ...current, connected: false }));

    const on = (name: string, handler: (data: any) => void) => {
      source.addEventListener(name, (event) => {
        touch();
        try {
          handler(JSON.parse((event as MessageEvent).data));
        } catch {
          // Ignore malformed frames rather than tearing down the stream.
        }
      });
    };

    on('snapshot', (data: { services: ServiceSummary[] }) => {
      client.setQueryData(keys.services, data.services);
    });

    on('service:update', (data: { service: ServiceSummary }) => {
      patchService(client, data.service);
    });

    on('service:checked', (data: { id: string; checkedAt: string }) => {
      client.setQueryData<ServiceSummary[]>(keys.services, (current) =>
        current?.map((entry) => (entry.id === data.id ? { ...entry, lastCheckedAt: data.checkedAt } : entry)),
      );
    });

    on('action:end', (data: { id: string; record: ActionRecord }) => {
      actionHandler.current?.(data.id, data.record);
      void client.invalidateQueries({ queryKey: keys.service(data.id) });
    });

    on('config:reload', () => {
      void client.invalidateQueries({ queryKey: keys.services });
      void client.invalidateQueries({ queryKey: keys.meta });
    });

    return () => source.close();
  }, [client]);

  // Treat a long silence as a dead stream even if the browser has not noticed.
  useEffect(() => {
    const timer = setInterval(() => {
      setState((current) =>
        current.lastEventAt && Date.now() - current.lastEventAt > 45_000
          ? { ...current, connected: false }
          : current,
      );
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  return state;
}

export interface RunActionInput {
  id: string;
  action: string;
}

/** Runs an action and folds the returned service state back into the cache. */
export function useRunAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: RunActionInput) => api.runAction(id, action),
    onSuccess: (response) => {
      patchService(client, response.service);
      void client.invalidateQueries({ queryKey: keys.service(response.service.id) });
    },
    onSettled: (_data, _error, variables) => {
      // Any cached log tail for this service is stale after an action.
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'logs' && query.queryKey[1] === variables.id,
      });
    },
  });
}

export function useRefreshService() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.refresh(id),
    onSuccess: (response) => patchService(client, response.service),
  });
}

export function useReloadConfig() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.reload(),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.services });
      void client.invalidateQueries({ queryKey: keys.meta });
    },
  });
}

/** Re-renders on an interval so relative timestamps stay honest. */
export function useTicker(intervalMs = 1_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return tick;
}

/** Global keyboard shortcuts: `/` focuses search, Escape closes overlays. */
export function useHotkeys(handlers: { search?: () => void; escape?: () => void }): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

      if (event.key === 'Escape') {
        ref.current.escape?.();
        return;
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        ref.current.search?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** Debounced value, used for the search field. */
export function useDebounced<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Persists small UI preferences (density, filters) across reloads. */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const storageKey = `switchyard.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // Storage disabled — preferences simply do not persist.
      }
    },
    [storageKey],
  );

  return [value, update];
}

export function useStateCounts(services: ServiceSummary[] | undefined) {
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const service of services ?? []) {
      counts.set(service.state, (counts.get(service.state) ?? 0) + 1);
    }
    return counts;
  }, [services]);
}
