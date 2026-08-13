import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/load.js';
import { EventBus } from '../src/core/events.js';
import { ServiceManager } from '../src/core/manager.js';

/**
 * HTTP-level tests for the resource endpoints and the error mapping.
 *
 * These use a throwaway config directory rather than the repository's own, so the
 * assertions do not move whenever a service definition is added. The manager is
 * built but never started: nothing here needs the polling or sampling loops, and
 * starting them would make the tests depend on real subprocesses.
 */

const GOOD_CONFIG = `version: 1
settings:
  host: 127.0.0.1
  port: 7878
monitoring:
  interval: 15s
  history: 20m
  for: 30s
services:
  - id: probe
    name: Probe
    type: command
    group: other
    monitoring:
      cpu:
        warning: 50%
        critical: 100%
    provider:
      status:
        run: [/bin/true]
        interpret: exit
`;

/** `history` is not a duration, and `nope` is not a key the schema knows. */
const BAD_CONFIG = `version: 1
monitoring:
  history: 1800
  nope: true
`;

let dir: string;
let app: FastifyInstance;
let manager: ServiceManager;

before(async () => {
  dir = await mkdtemp(resolve(tmpdir(), 'switchyard-api-'));
  await mkdir(resolve(dir, 'services.d'), { recursive: true });
  await writeFile(resolve(dir, 'switchyard.yaml'), GOOD_CONFIG, 'utf8');
  await writeFile(resolve(dir, 'bad.yaml'), BAD_CONFIG, 'utf8');

  const config = await loadConfig(resolve(dir, 'switchyard.yaml'));
  manager = new ServiceManager(config, new EventBus());
  app = await createApp({
    manager,
    bus: new EventBus(),
    version: '0.0.0-test',
    configPathOverride: resolve(dir, 'switchyard.yaml'),
  });
});

after(async () => {
  manager.stop();
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function get(url: string): Promise<{ status: number; body: any }> {
  const response = await app.inject({ method: 'GET', url });
  return { status: response.statusCode, body: response.json() };
}

describe('GET /api/meta', () => {
  it('carries the host facts needed to read absolute thresholds', async () => {
    const { body } = await get('/api/meta');
    assert.equal(typeof body.host.hostname, 'string');
    assert.ok(body.host.cpuCount >= 1);
    assert.ok(body.host.totalMemoryBytes > 0);
  });

  it('publishes the metric vocabulary with units', async () => {
    const { body } = await get('/api/meta');
    assert.deepEqual(
      body.monitoring.metrics.map((entry: { metric: string }) => entry.metric),
      ['cpu', 'memory', 'diskRead', 'diskWrite', 'netRx', 'netTx'],
    );
    assert.equal(
      body.monitoring.metrics.find((entry: { metric: string }) => entry.metric === 'memory').unit,
      'bytes',
    );
    assert.equal(body.monitoring.historyMs, 1_200_000);
  });
});

describe('GET /api/resources', () => {
  it('returns one entry per service with the interpretation context', async () => {
    const { status, body } = await get('/api/resources');
    assert.equal(status, 200);
    assert.equal(body.services.length, 1);
    assert.equal(body.services[0].id, 'probe');
    assert.equal(body.truncated, 0);
    assert.ok(body.host.cpuCount >= 1);
    assert.equal(body.monitoring.historyMs, 1_200_000);
  });

  it('reports every metric as unmeasured before the first sample, never as zero', async () => {
    const { body } = await get('/api/resources');
    const service = body.services[0];
    assert.deepEqual(service.unmeasured, ['cpu', 'memory', 'diskRead', 'diskWrite', 'netRx', 'netTx']);
    assert.equal(service.sampledAt, undefined);
    assert.equal(service.memory, undefined);
    for (const metric of service.metrics) assert.equal(metric.value, undefined);
  });

  it('still exposes thresholds that cannot fire yet', async () => {
    const { body } = await get('/api/resources');
    const cpu = body.services[0].metrics.find((entry: { metric: string }) => entry.metric === 'cpu');
    assert.equal(cpu.state, 'unmeasured');
    assert.equal(cpu.warning, 50);
    assert.equal(cpu.critical, 100);
  });

  it('narrows to one service', async () => {
    const { body } = await get('/api/resources?service=probe');
    assert.equal(body.services.length, 1);
  });

  it('404s an unknown service rather than returning an empty list', async () => {
    const { status, body } = await get('/api/resources?service=nope');
    assert.equal(status, 404);
    assert.equal(body.error.code, 'not_found');
  });

  it('rejects a sort key that is not a metric', async () => {
    const { status, body } = await get('/api/resources?sort=uptime');
    assert.equal(status, 400);
    assert.equal(body.error.code, 'bad_request');
  });
});

describe('GET /api/services/:id/resources/history', () => {
  it('reports the window, the retention and an empty series honestly', async () => {
    const { status, body } = await get('/api/services/probe/resources/history');
    assert.equal(status, 200);
    assert.equal(body.windowMs, 900_000);
    assert.equal(body.retentionMs, 1_200_000);
    assert.equal(body.samples, 0);
    assert.equal(body.spanMs, 0);
    assert.deepEqual(body.stats, []);
    assert.deepEqual(body.buckets, []);
    assert.equal(body.intervalMs, 15_000);
  });

  it('clamps a window longer than the configured retention', async () => {
    const { body } = await get('/api/services/probe/resources/history?window=2h');
    assert.equal(body.windowMs, 1_200_000);
  });

  it('accepts a duration string and rejects a bare number', async () => {
    assert.equal((await get('/api/services/probe/resources/history?window=5m')).body.windowMs, 300_000);
    const bad = await get('/api/services/probe/resources/history?window=300');
    assert.equal(bad.status, 400);
  });

  it('bounds the requested bucket count', async () => {
    assert.equal((await get('/api/services/probe/resources/history?buckets=121')).status, 400);
    assert.equal((await get('/api/services/probe/resources/history?buckets=0')).status, 400);
    assert.equal((await get('/api/services/probe/resources/history?buckets=120')).status, 200);
  });

  it('404s an unknown service', async () => {
    assert.equal((await get('/api/services/nope/resources/history')).status, 404);
  });
});
