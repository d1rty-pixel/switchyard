import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { resolveConfig } from '../src/config.js';
import { createServer } from '../src/server.js';
import { ANTIVIRUS_DETAIL, FakeSwitchyard, RESTART_RESULT, withDefaultRoutes } from './helpers.js';

/**
 * End-to-end over MCP itself: a real client, a real server, in-memory transport,
 * and a fake Switchyard behind it.
 *
 * The assertions are mostly about the *text* block, because that is the half a
 * client is guaranteed to render. `structuredContent` is checked to be present and
 * to agree with it, never as the only place a fact appears.
 */

const fake = new FakeSwitchyard();
let client: Client;

async function callText(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text?: string }[];
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

before(async () => {
  await fake.start();
  withDefaultRoutes(fake);

  const { server } = createServer(resolveConfig({ argv: ['--url', fake.url], env: {} }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

after(async () => {
  await client.close();
  await fake.stop();
});

describe('tool surface', () => {
  it('registers exactly the intended tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [
        'apply_config_reload',
        'get_alerts',
        'get_logs',
        'get_resource_history',
        'get_resource_usage',
        'get_service',
        'list_services',
        'preview_config_reload',
        'refresh_service',
        'run_action',
        'switchyard_server_info',
      ],
    );
  });

  it('marks the reads read-only and the mutations destructive', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('get_resource_usage')?.annotations?.readOnlyHint, true);
    assert.equal(byName.get('run_action')?.annotations?.destructiveHint, true);
    assert.equal(byName.get('apply_config_reload')?.annotations?.destructiveHint, true);
    assert.equal(byName.get('preview_config_reload')?.annotations?.readOnlyHint, true);
  });

  it('accepts only id-shaped service parameters', async () => {
    const result = await call('get_service', { service: 'not a valid id!' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /lowercase letters/);
  });
});

describe('switchyard_server_info', () => {
  it('reports version, host and monitoring settings in the text', async () => {
    const text = await callText('switchyard_server_info');
    assert.match(text, /Switchyard 0\.1\.0 at http:\/\/127\.0\.0\.1:\d+/);
    assert.match(text, /Up 1h/);
    assert.match(text, /8 CPU threads/);
    assert.match(text, /800% = the whole machine/);
    assert.match(text, /16 GiB RAM/);
    assert.match(text, /sample every 15s/);
    assert.match(text, /history 30m/);
    assert.match(text, /Providers: command, systemd/);
  });
});

describe('list_services', () => {
  it('lists services compactly, marking confirm-required actions', async () => {
    const text = await callText('list_services');
    assert.match(text, /2 of 2 service\(s\)/);
    assert.match(text, /antivirus\s+running\s+systemd/);
    assert.match(text, /start, stop\*, restart/);
    assert.match(text, /needs confirm: true/);
  });

  it('does not dump the full service payload into the text', async () => {
    const text = await callText('list_services');
    // Status metrics, probe output and provider config belong to get_service.
    assert.doesNotMatch(text, /Main PID/);
    assert.doesNotMatch(text, /antivirus\.service/);
  });

  it('mirrors the roster in structuredContent', async () => {
    const result = await call('list_services');
    const structured = result.structuredContent as { total: number; services: { id: string }[] };
    assert.equal(structured.total, 2);
    assert.deepEqual(
      structured.services.map((service) => service.id),
      ['antivirus', 'sample-worker'],
    );
  });

  it('filters by state, group and tag', async () => {
    assert.match(await callText('list_services', { state: 'running' }), /1 of 2 service\(s\) matching state=running/);
    assert.match(await callText('list_services', { group: 'development' }), /sample-worker/);
    assert.match(await callText('list_services', { tag: 'antivirus' }), /antivirus/);
  });

  it('says so when a filter matches nothing', async () => {
    const text = await callText('list_services', { state: 'failed' });
    assert.match(text, /No service matches state=failed/);
  });
});

describe('get_service', () => {
  it('renders status, endpoints, actions and resources', async () => {
    const text = await callText('get_service', { service: 'antivirus' });
    assert.match(text, /antivirus — Antivirus \(systemd, group infrastructure\)/);
    assert.match(text, /State running, since 2026-08-13T10:00:00/);
    assert.match(text, /Main PID: 1110443/);
    assert.match(text, /stop\* — Stop \[danger\]/);
    assert.match(text, /cpu 3\.92%/);
    assert.match(text, /Logs available/);
  });

  it('never renders the provider configuration block', async () => {
    const text = await callText('get_service', { service: 'antivirus' });
    assert.doesNotMatch(text, /providerConfig/);
  });

  it('renders history entries of every kind, not only actions', async () => {
    const text = await callText('get_service', { service: 'antivirus' });
    assert.match(text, /Recent activity/);
    assert.match(text, /\[action\/info\] Restart \(2s, exit 0\): Restart finished/);
    assert.match(text, /\[state\/error\] running → failed: unit entered failed state/);
  });

  it('reports an unknown service with the API error code', async () => {
    const result = await call('get_service', { service: 'nope' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /not_found/);
  });
});

describe('get_resource_usage', () => {
  it('carries values, units, thresholds and sample age in the text', async () => {
    const text = await callText('get_resource_usage');
    assert.match(text, /8 CPU threads/);
    assert.match(text, /cpu 3\.92% \(26\.1% of warning 15%\)/);
    assert.match(text, /sampled 5s ago/);
    assert.match(text, /systemd cgroup/);
  });

  it('shows a pending breach with its timing', async () => {
    const text = await callText('get_resource_usage');
    assert.match(text, /memory 317 MiB \[over warning for 12s, alerts in 48s\]/);
    assert.match(text, /PEND\s+antivirus/);
  });

  it('names the metrics with no measurement instead of showing zeroes', async () => {
    const text = await callText('get_resource_usage');
    assert.match(text, /no measurement for: diskRead, diskWrite, netRx, netTx/);
    assert.doesNotMatch(text, /netRx 0 B\/s/);
  });

  it('explains a service with nothing to measure', async () => {
    const text = await callText('get_resource_usage');
    assert.match(text, /nothing to measure \(service is stopped\)/);
  });

  it('passes sort and limit through to the API', async () => {
    fake.requests.length = 0;
    await call('get_resource_usage', { sort: 'cpu', limit: 5 });
    assert.deepEqual(fake.requests.at(-1)?.query, { sort: 'cpu', limit: '5' });
  });

  it('mirrors the whole payload in structuredContent', async () => {
    const result = await call('get_resource_usage');
    const structured = result.structuredContent as { services: { id: string; worst: string }[] };
    assert.equal(structured.services[0]?.id, 'antivirus');
    assert.equal(structured.services[0]?.worst, 'pending');
  });
});

describe('get_resource_history', () => {
  it('reports statistics and the share of samples above each threshold', async () => {
    const text = await callText('get_resource_history', { service: 'antivirus' });
    assert.match(text, /60 sample\(s\) covering 14m 45s/);
    assert.match(text, /min 2\.1% · avg 12\.6% · p95 22\.8% · max 24\.4% · latest 3\.9%/);
    assert.match(text, /40% of samples ≥ warning 15%/);
    assert.match(text, /0% ≥ critical 100%/);
  });

  it('renders a bounded bucket series with its width', async () => {
    const text = await callText('get_resource_history', { service: 'antivirus' });
    assert.match(text, /2 bucket\(s\) of 7m 30s/);
    assert.match(text, /cpu avg per bucket: 20\.2 5/);
    assert.match(text, /peak 24\.4%/);
  });

  it('passes window and buckets through', async () => {
    fake.requests.length = 0;
    await call('get_resource_history', { service: 'antivirus', window: '5m', buckets: 12 });
    assert.deepEqual(fake.requests.at(-1)?.query, { window: '5m', buckets: '12' });
  });

  it('rejects a window without a unit', async () => {
    const result = await call('get_resource_history', { service: 'antivirus', window: '300' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /a bare number is not accepted/);
  });

  it('explains an empty history rather than returning nothing', async () => {
    fake.route('GET /api/services/sample-worker/resources/history', {
      body: {
        id: 'sample-worker',
        windowMs: 900_000,
        from: '2026-08-13T11:45:00.000Z',
        to: '2026-08-13T12:00:00.000Z',
        retentionMs: 1_800_000,
        samples: 0,
        spanMs: 0,
        intervalMs: 15_000,
        stats: [],
        buckets: [],
      },
    });
    const text = await callText('get_resource_history', { service: 'sample-worker' });
    assert.match(text, /no resource samples retained in the last 15m/);
    assert.match(text, /Retention is 30m/);
  });
});

describe('get_alerts', () => {
  it('says plainly when nothing is alerting', async () => {
    const text = await callText('get_alerts');
    assert.match(text, /No active resource alerts/);
  });

  it('renders value, threshold and duration for an active alert', async () => {
    fake.route('GET /api/alerts', {
      body: {
        alerts: [
          {
            key: 'antivirus:cpu',
            serviceId: 'antivirus',
            serviceName: 'Antivirus',
            metric: 'cpu',
            label: 'CPU',
            unit: 'percent',
            severity: 'critical',
            value: 412,
            threshold: 100,
            breachedAt: '2026-08-13T11:57:50.000Z',
            activatedAt: '2026-08-13T11:58:20.000Z',
            updatedAt: '2026-08-13T12:00:00.000Z',
            active: true,
          },
        ],
      },
    });
    const text = await callText('get_alerts');
    assert.match(text, /CRITICAL antivirus cpu 412% ≥ 100%/);
    assert.match(text, /breach began 2026-08-13T11:57:50/);
    fake.route('GET /api/alerts', { body: { alerts: [] } });
  });
});

describe('get_logs', () => {
  it('returns the lines with their source', async () => {
    fake.route('GET /api/services/antivirus/logs', {
      body: {
        id: 'antivirus',
        source: 'journalctl -u antivirus.service',
        lines: ['line one', 'line two'],
        fetchedAt: new Date().toISOString(),
      },
    });
    const text = await callText('get_logs', { service: 'antivirus', tail: 50 });
    assert.match(text, /2 line\(s\) from journalctl -u antivirus\.service/);
    assert.match(text, /line one\nline two/);
    assert.equal(fake.requests.at(-1)?.query.tail, '50');
  });

  it('joins container filters into the query the API expects', async () => {
    fake.requests.length = 0;
    await call('get_logs', { service: 'antivirus', containers: ['web', 'db'] });
    assert.equal(fake.requests.at(-1)?.query.containers, 'web,db');
  });

  it('reports a service that exposes no logs', async () => {
    fake.route('GET /api/services/sample-worker/logs', {
      status: 422,
      body: { error: { code: 'unsupported', message: 'service "sample-worker" does not expose logs' } },
    });
    const result = await call('get_logs', { service: 'sample-worker' });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /unsupported/);
  });
});

describe('run_action', () => {
  it('runs an action that needs no confirmation', async () => {
    fake.route('POST /api/services/antivirus/actions/restart', { body: RESTART_RESULT });
    const text = await callText('run_action', { service: 'antivirus', action: 'restart' });
    assert.match(text, /ok — Restart on antivirus \(2s, exit 0\)/);
    assert.match(text, /State: running → running/);
  });

  it('refuses a confirm-required action without confirm: true, and does not call the API', async () => {
    fake.requests.length = 0;
    const result = await call('run_action', { service: 'antivirus', action: 'stop' });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.match(text, /needs confirmation and was NOT run/);
    assert.match(text, /systemctl stop antivirus\.service/);
    assert.equal(
      fake.requests.some((request) => request.method === 'POST'),
      false,
    );
  });

  it('runs the same action once confirm: true is passed', async () => {
    fake.route('POST /api/services/antivirus/actions/stop', {
      body: {
        ...RESTART_RESULT,
        message: 'Stop finished',
        record: { ...RESTART_RESULT.record, actionId: 'stop', label: 'Stop' },
        service: { ...RESTART_RESULT.service, state: 'stopped' },
      },
    });
    const text = await callText('run_action', { service: 'antivirus', action: 'stop', confirm: true });
    assert.match(text, /ok — Stop on antivirus/);
    assert.match(text, /State: running → stopped/);
  });

  it('rejects an action the service does not declare, and lists the real ones', async () => {
    const result = await call('run_action', { service: 'antivirus', action: 'destroy' });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.match(text, /not an action of antivirus/);
    assert.match(text, /Available: start, stop, restart/);
  });

  it('notes when an action is not offered in the current state but runs it anyway', async () => {
    fake.route('POST /api/services/antivirus/actions/start', {
      body: { ...RESTART_RESULT, message: 'Start finished' },
    });
    const text = await callText('run_action', { service: 'antivirus', action: 'start' });
    assert.match(text, /offers "start" only in stopped\/failed\/unknown/);
  });

  it('marks a failed command as an error while still reporting its output', async () => {
    fake.route('POST /api/services/antivirus/actions/restart', {
      body: {
        ok: false,
        message: 'Restart failed: exit 1',
        record: { ...RESTART_RESULT.record, ok: false, exitCode: 1, message: 'Restart failed: exit 1' },
        output: { exitCode: 1, stderr: 'Job for antivirus.service failed' },
        service: { ...ANTIVIRUS_DETAIL, state: 'failed' },
      },
    });
    const result = await call('run_action', { service: 'antivirus', action: 'restart' });
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.match(text, /FAILED — Restart/);
    assert.match(text, /Job for antivirus\.service failed/);
    fake.route('POST /api/services/antivirus/actions/restart', { body: RESTART_RESULT });
  });
});

describe('refresh_service', () => {
  it('reports the fresh state', async () => {
    fake.route('POST /api/services/antivirus/refresh', { body: { service: ANTIVIRUS_DETAIL } });
    const text = await callText('refresh_service', { service: 'antivirus' });
    assert.match(text, /antivirus is running — Antivirus service/);
    assert.match(text, /Probed at 2026-08-13T12:00:00/);
  });
});

describe('config reload', () => {
  it('previews without applying', async () => {
    fake.route('GET /api/reload/preview', {
      body: {
        path: '/srv/switchyard/switchyard.yaml',
        services: 3,
        warnings: ['demo-stack: group "qa" is not declared under groups:'],
        diff: { added: ['demo-stack'], removed: [], changed: ['antivirus'], unchanged: 1 },
      },
    });
    const text = await callText('preview_config_reload');
    assert.match(text, /3 service\(s\) would be configured/);
    assert.match(text, /added:   demo-stack/);
    assert.match(text, /changed: antivirus/);
    assert.match(text, /Call apply_config_reload/);
    assert.match(text, /group "qa" is not declared/);
  });

  it('reports nothing to do when the diff is empty', async () => {
    fake.route('GET /api/reload/preview', {
      body: {
        path: '/srv/switchyard/switchyard.yaml',
        services: 2,
        warnings: [],
        diff: { added: [], removed: [], changed: [], unchanged: 2 },
      },
    });
    const text = await callText('preview_config_reload');
    assert.match(text, /No changes — 2 service\(s\) identical/);
    assert.match(text, /Nothing to apply/);
  });

  it('applies a reload', async () => {
    fake.route('POST /api/reload', {
      body: { ok: true, path: '/srv/switchyard/switchyard.yaml', services: 3, warnings: [] },
    });
    const text = await callText('apply_config_reload');
    assert.match(text, /Reloaded \/srv\/switchyard\/switchyard\.yaml — 3 service\(s\)/);
  });

  it('surfaces a refusal while an action is running', async () => {
    fake.route('POST /api/reload', {
      status: 409,
      body: { error: { code: 'conflict', message: 'cannot reload while actions are running: demo-stack' } },
    });
    const result = await call('apply_config_reload');
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /cannot reload while actions are running/);
  });
});

describe('unreachable Switchyard', () => {
  it('answers every tool with an actionable message instead of failing the call', async () => {
    const { server } = createServer(resolveConfig({ argv: ['--url', 'http://127.0.0.1:1'], env: {} }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const lonely = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([lonely.connect(clientTransport), server.connect(serverTransport)]);

    const result = await lonely.callTool({ name: 'list_services', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Switchyard is not reachable/);

    await lonely.close();
  });
});

describe('rejected configuration', () => {
  it('lists the individual issues instead of a bare failure message', async () => {
    fake.route('GET /api/reload/preview', {
      status: 422,
      body: {
        error: {
          code: 'invalid_config',
          message: 'invalid configuration in /srv/switchyard/switchyard.yaml',
          details: {
            issues: [
              "monitoring: Unrecognized key(s) in object: 'nope'",
              'monitoring.history: invalid duration "1800": expected a value with a unit',
            ],
          },
        },
      },
    });

    const result = await call('preview_config_reload');
    assert.equal(result.isError, true);
    const text = JSON.stringify(result.content);
    assert.match(text, /invalid_config/);
    // The reason has to survive, not just the verdict.
    assert.match(text, /• monitoring.history: invalid duration/);
    assert.match(text, /Unrecognized key/);
  });
});
