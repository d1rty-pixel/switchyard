import type {
  ActionResponse,
  ApiErrorBody,
  LogsResponse,
  MetaResponse,
  ReloadPreview,
  ServiceDetail,
  ServiceSummary,
} from './types';

/** Error carrying the server's machine-readable code and details. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new ApiError(0, 'network_error', `cannot reach the Switchyard API (${(error as Error).message})`);
  }

  const text = await response.text();
  const body = text ? safeJson(text) : undefined;

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | undefined;
    throw new ApiError(
      response.status,
      errorBody?.error?.code ?? 'http_error',
      errorBody?.error?.message ?? `${response.status} ${response.statusText}`,
      errorBody?.error?.details,
    );
  }

  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const api = {
  meta: () => request<MetaResponse>('/api/meta'),
  services: () => request<{ services: ServiceSummary[] }>('/api/services').then((body) => body.services),
  service: (id: string) => request<ServiceDetail>(`/api/services/${encodeURIComponent(id)}`),
  refresh: (id: string) =>
    request<{ service: ServiceSummary }>(`/api/services/${encodeURIComponent(id)}/refresh`, { method: 'POST' }),
  runAction: (id: string, action: string) =>
    request<ActionResponse>(
      `/api/services/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      { method: 'POST' },
    ),
  logs: (id: string, tail?: number, containers?: string[]) => {
    const params = new URLSearchParams();
    if (tail) params.set('tail', String(tail));
    if (containers?.length) params.set('containers', containers.join(','));
    const query = params.toString();
    return request<LogsResponse>(`/api/services/${encodeURIComponent(id)}/logs${query ? `?${query}` : ''}`);
  },
  reload: () => request<{ ok: boolean; path: string; services: number }>('/api/reload', { method: 'POST' }),
  reloadPreview: () => request<ReloadPreview>('/api/reload/preview'),
};
