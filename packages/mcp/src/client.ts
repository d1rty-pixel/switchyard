import type { McpConfig } from './config.js';
import type {
  ActionResponse,
  AlertsResponse,
  HealthResponse,
  HistoryResponse,
  LogsResponse,
  MetaResponse,
  RefreshResponse,
  ReloadPreviewResponse,
  ReloadResponse,
  ResourcesResponse,
  ServiceDetail,
  ServicesResponse,
} from './wire.js';

/**
 * Thin HTTP client for the Switchyard API.
 *
 * Every method is one request to one endpoint. There is no caching, no polling
 * and no derived state: the running server already keeps all of it, and a second
 * copy here could only ever be a staler version of the dashboard's.
 *
 * Path segments carrying a service or action id are percent-encoded even though
 * the server's own schemas restrict both to `[a-z0-9._-]` — the encoding is what
 * makes that a validation rule rather than something this client relies on.
 */

/** The server answered, and said no. Carries its machine-readable code. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The server could not be reached at all — almost always "it is not running". */
export class UnreachableError extends Error {
  override readonly name = 'UnreachableError';
  constructor(
    readonly baseUrl: string,
    readonly reason: string,
  ) {
    super(
      `Switchyard is not reachable at ${baseUrl} (${reason}). ` +
        'Start it with `npm start` in the Switchyard checkout, or point this MCP server ' +
        'somewhere else with --url / SWITCHYARD_URL.',
    );
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export type QueryValue = string | number | boolean | undefined;

export class SwitchyardClient {
  constructor(private readonly config: McpConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl;
  }

  health(): Promise<HealthResponse> {
    return this.request('GET', '/api/health');
  }

  meta(): Promise<MetaResponse> {
    return this.request('GET', '/api/meta');
  }

  services(): Promise<ServicesResponse> {
    return this.request('GET', '/api/services');
  }

  service(id: string): Promise<ServiceDetail> {
    return this.request('GET', `/api/services/${encodeURIComponent(id)}`);
  }

  alerts(): Promise<AlertsResponse> {
    return this.request('GET', '/api/alerts');
  }

  resources(query: { service?: string; sort?: string; limit?: number } = {}): Promise<ResourcesResponse> {
    return this.request('GET', '/api/resources', { query });
  }

  history(
    id: string,
    query: { window?: string; buckets?: number } = {},
  ): Promise<HistoryResponse> {
    return this.request('GET', `/api/services/${encodeURIComponent(id)}/resources/history`, { query });
  }

  logs(id: string, query: { tail?: number; containers?: string } = {}): Promise<LogsResponse> {
    return this.request('GET', `/api/services/${encodeURIComponent(id)}/logs`, {
      query,
      timeoutMs: this.config.logsTimeoutMs,
    });
  }

  runAction(id: string, actionId: string): Promise<ActionResponse> {
    return this.request(
      'POST',
      `/api/services/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionId)}`,
      { timeoutMs: this.config.actionTimeoutMs },
    );
  }

  refresh(id: string): Promise<RefreshResponse> {
    return this.request('POST', `/api/services/${encodeURIComponent(id)}/refresh`, {
      timeoutMs: this.config.actionTimeoutMs,
    });
  }

  reloadPreview(): Promise<ReloadPreviewResponse> {
    return this.request('GET', '/api/reload/preview');
  }

  reload(): Promise<ReloadResponse> {
    return this.request('POST', '/api/reload', { timeoutMs: this.config.actionTimeoutMs });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, QueryValue>; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new UnreachableError(this.config.baseUrl, describeFetchError(error, timeoutMs));
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // A non-JSON body from the API surface means something other than
      // Switchyard is answering on this port.
      throw new ApiError(
        response.status,
        'invalid_response',
        `${method} ${path} returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`,
      );
    }

    if (!response.ok) {
      const error = (body as ErrorBody | undefined)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? `${method} ${path} failed with ${response.status}`,
        error?.details,
      );
    }

    return body as T;
  }
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `no response within ${timeoutMs} ms`;
  }
  const cause = (error as { cause?: { code?: string } }).cause;
  if (cause?.code) return cause.code;
  return (error as Error).message ?? 'unknown error';
}
