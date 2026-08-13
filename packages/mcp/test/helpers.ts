import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import type {
  ActionResponse,
  HealthResponse,
  HistoryResponse,
  MetaResponse,
  ResourcesResponse,
  ServiceDetail,
  ServiceSummary,
} from '../src/wire.js';

/**
 * A stand-in for the Switchyard API.
 *
 * The MCP package is a client, so its tests need a server to be a client of. A
 * real loopback HTTP server is used rather than a stubbed `fetch`, because the
 * things worth testing here — query building, id encoding, status-to-error
 * mapping, timeouts — all live in the layer a stub would replace.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
}

export interface Route {
  status?: number;
  body?: unknown;
  /** Sent verbatim instead of JSON, for the non-JSON-body case. */
  raw?: string;
  delayMs?: number;
}

export class FakeSwitchyard {
  private server: Server | undefined;
  readonly requests: RecordedRequest[] = [];
  private routes = new Map<string, Route>();
  url = '';

  /** `route('GET /api/health', {...})` */
  route(key: string, route: Route): this {
    this.routes.set(key, route);
    return this;
  }

  async start(): Promise<this> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const address = this.server?.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    this.requests.push({ method: request.method ?? 'GET', path: url.pathname, query });

    const route = this.routes.get(`${request.method} ${url.pathname}`);
    if (!route) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { code: 'not_found', message: `no such endpoint: ${url.pathname}` } }),
      );
      return;
    }

    if (route.delayMs) await new Promise((resolve) => setTimeout(resolve, route.delayMs));

    if (route.raw !== undefined) {
      response.writeHead(route.status ?? 200, { 'content-type': 'text/plain' });
      response.end(route.raw);
      return;
    }

    response.writeHead(route.status ?? 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(route.body));
  }
}

// ── canned payloads ───────────────────────────────────────────────────────────

export const HEALTH: HealthResponse = {
  ok: true,
  version: '0.1.0',
  uptimeMs: 3_600_000,
  services: 2,
  subscribers: 1,
};

export const META: MetaResponse = {
  app: { name: 'Switchyard', version: '0.1.0' },
  configPath: '/srv/switchyard/switchyard.yaml',
  serviceDirs: ['/srv/switchyard/services.d'],
  configWarnings: [],
  disabledServices: [],
  groups: [{ id: 'infrastructure', name: 'Infrastructure', order: 30 }],
  providers: [
    { type: 'command', label: 'Command', description: 'Predefined commands.' },
    { type: 'systemd', label: 'systemd', description: 'A systemd unit.' },
  ],
  settings: {
    statusIntervalMs: 6_000,
    logsTail: 200,
    monitoring: { enabled: true, intervalMs: 15_000 },
  },
  host: { hostname: 'testbox', cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3 },
  monitoring: {
    enabled: true,
    intervalMs: 15_000,
    historyMs: 1_800_000,
    metrics: [
      { metric: 'cpu', label: 'CPU', unit: 'percent' },
      { metric: 'memory', label: 'Memory', unit: 'bytes' },
      { metric: 'diskRead', label: 'Disk read', unit: 'bytesPerSecond' },
      { metric: 'diskWrite', label: 'Disk write', unit: 'bytesPerSecond' },
      { metric: 'netRx', label: 'Net in', unit: 'bytesPerSecond' },
      { metric: 'netTx', label: 'Net out', unit: 'bytesPerSecond' },
    ],
    defaults: { forMs: 30_000, clearBelow: 0.9, cooldownMs: 300_000, historyMs: 1_800_000 },
    thresholds: {},
  },
};

export const ANTIVIRUS_SUMMARY: ServiceSummary = {
  id: 'antivirus',
  name: 'Antivirus',
  description: 'Antivirus service',
  type: 'systemd',
  providerLabel: 'systemd',
  group: 'infrastructure',
  tags: ['systemd', 'antivirus'],
  state: 'running',
  statusSummary: 'Antivirus service',
  since: '2026-08-13T10:00:00.000Z',
  lastCheckedAt: '2026-08-13T12:00:00.000Z',
  checking: false,
  busy: null,
  metrics: [{ label: 'Main PID', value: '1110443', kind: 'mono' }],
  warnings: [],
  errors: [],
  ports: [],
  urls: [],
  actions: [
    { id: 'start', label: 'Start', kind: 'primary', enabledIn: ['stopped', 'failed', 'unknown'] },
    {
      id: 'stop',
      label: 'Stop',
      kind: 'danger',
      confirm: true,
      description: 'systemctl stop antivirus.service',
      enabledIn: ['running', 'degraded'],
    },
    { id: 'restart', label: 'Restart', kind: 'secondary', enabledIn: ['running', 'degraded', 'failed'] },
  ],
  supportsLogs: true,
  resources: {
    at: '2026-08-13T12:00:00.000Z',
    attribution: 'systemd cgroup — the unit and all processes it spawned',
    cpuPercent: 3.92,
    memoryBytes: 332_079_104,
  },
  alerts: [],
  monitored: true,
};

export const WORKER_SUMMARY: ServiceSummary = {
  id: 'sample-worker',
  name: 'Sample worker',
  type: 'command',
  providerLabel: 'Command',
  group: 'development',
  tags: ['demo'],
  state: 'stopped',
  checking: false,
  busy: null,
  metrics: [],
  warnings: [],
  errors: [],
  ports: [],
  urls: [],
  actions: [{ id: 'start', label: 'Start', kind: 'primary' }],
  supportsLogs: false,
  resources: null,
  alerts: [],
  monitored: true,
};

export const ANTIVIRUS_DETAIL: ServiceDetail = {
  ...ANTIVIRUS_SUMMARY,
  statusDetail: 'active (running) since Thu 2026-08-13 10:00:00 UTC',
  childStatuses: [],
  history: [
    {
      actionId: 'restart',
      label: 'Restart',
      ok: true,
      message: 'Restart finished',
      startedAt: '2026-08-13T09:59:58.000Z',
      durationMs: 2_100,
      exitCode: 0,
    },
  ],
  source: '/srv/switchyard/services.d/antivirus.yaml',
  envKeys: [],
  providerConfig: { unit: 'antivirus.service' },
  monitoringConfig: {
    enabled: true,
    clearBelow: 0.9,
    cooldownMs: 300_000,
    thresholds: {
      cpu: { warning: 15, critical: 100, forMs: 30_000, unit: 'percent' },
      memory: { warning: 402_653_184, critical: 805_306_368, forMs: 60_000, unit: 'bytes' },
    },
  },
};

export const RESOURCES: ResourcesResponse = {
  at: '2026-08-13T12:00:05.000Z',
  host: META.host,
  monitoring: {
    enabled: true,
    intervalMs: 15_000,
    historyMs: 1_800_000,
    metrics: META.monitoring.metrics,
  },
  truncated: 0,
  services: [
    {
      id: 'antivirus',
      name: 'Antivirus',
      type: 'systemd',
      providerLabel: 'systemd',
      group: 'infrastructure',
      state: 'running',
      monitored: true,
      sampling: 'ok',
      sampledAt: '2026-08-13T12:00:00.000Z',
      ageMs: 5_000,
      attribution: 'systemd cgroup — the unit and all processes it spawned',
      metrics: [
        {
          metric: 'cpu',
          label: 'CPU',
          unit: 'percent',
          value: 3.92,
          state: 'ok',
          warning: 15,
          critical: 100,
          forMs: 30_000,
          percentOfWarning: 26.1,
          percentOfCritical: 3.9,
        },
        {
          metric: 'memory',
          label: 'Memory',
          unit: 'bytes',
          value: 332_079_104,
          state: 'pending',
          warning: 402_653_184,
          critical: 805_306_368,
          forMs: 60_000,
          percentOfWarning: 82.5,
          pendingSeverity: 'warning',
          breachingForMs: 12_000,
          activatesInMs: 48_000,
        },
      ],
      unmeasured: ['diskRead', 'diskWrite', 'netRx', 'netTx'],
      memory: { bytes: 332_079_104 },
      alerts: [],
      worst: 'pending',
      historySamples: 42,
    },
    {
      id: 'sample-worker',
      name: 'Sample worker',
      type: 'command',
      providerLabel: 'Command',
      group: 'development',
      state: 'stopped',
      monitored: true,
      sampling: 'no-sample',
      metrics: [],
      unmeasured: ['cpu', 'memory', 'diskRead', 'diskWrite', 'netRx', 'netTx'],
      alerts: [],
      worst: 'unmeasured',
      historySamples: 0,
    },
  ],
};

export const HISTORY: HistoryResponse = {
  id: 'antivirus',
  windowMs: 900_000,
  from: '2026-08-13T11:45:00.000Z',
  to: '2026-08-13T12:00:00.000Z',
  retentionMs: 1_800_000,
  samples: 60,
  spanMs: 885_000,
  intervalMs: 15_000,
  stats: [
    {
      metric: 'cpu',
      label: 'CPU',
      unit: 'percent',
      samples: 60,
      min: 2.1,
      max: 24.4,
      average: 12.6,
      p95: 22.8,
      latest: 3.9,
      firstAt: '2026-08-13T11:45:15.000Z',
      lastAt: '2026-08-13T12:00:00.000Z',
      spanMs: 885_000,
      warning: 15,
      critical: 100,
      fractionAboveWarning: 0.4,
      fractionAboveCritical: 0,
    },
  ],
  buckets: [
    {
      at: '2026-08-13T11:45:00.000Z',
      endAt: '2026-08-13T11:52:30.000Z',
      samples: 30,
      values: { cpu: { average: 20.2, max: 24.4 } },
    },
    {
      at: '2026-08-13T11:52:30.000Z',
      endAt: '2026-08-13T12:00:00.000Z',
      samples: 30,
      values: { cpu: { average: 5, max: 8.1 } },
    },
  ],
};

export const RESTART_RESULT: ActionResponse = {
  ok: true,
  message: 'Restart finished',
  record: {
    actionId: 'restart',
    label: 'Restart',
    ok: true,
    message: 'Restart finished',
    startedAt: '2026-08-13T12:00:00.000Z',
    durationMs: 2_100,
    exitCode: 0,
  },
  output: { exitCode: 0, stdout: '', stderr: '' },
  service: { ...ANTIVIRUS_SUMMARY, state: 'running' },
};

/** Registers the whole read surface, which most tool tests need. */
export function withDefaultRoutes(fake: FakeSwitchyard): FakeSwitchyard {
  return fake
    .route('GET /api/health', { body: HEALTH })
    .route('GET /api/meta', { body: META })
    .route('GET /api/services', { body: { services: [ANTIVIRUS_SUMMARY, WORKER_SUMMARY] } })
    .route('GET /api/services/antivirus', { body: ANTIVIRUS_DETAIL })
    .route('GET /api/alerts', { body: { alerts: [] } })
    .route('GET /api/resources', { body: RESOURCES })
    .route('GET /api/services/antivirus/resources/history', { body: HISTORY });
}
