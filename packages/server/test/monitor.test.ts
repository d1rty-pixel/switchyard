import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ResourceMonitor, type MonitorHost, type MonitorResult, type MonitorTarget } from '../src/core/monitor.js';
import { SampleBatch } from '../src/core/sample-batch.js';
import { logger } from '../src/core/logger.js';
import type { ExecResult } from '../src/core/exec.js';
import type { ProviderSample } from '../src/core/resources.js';
import type { ResolvedMonitoring } from '../src/config/monitoring.js';
import type { Provider, ProviderContext, ResolvedService } from '../src/providers/types.js';

const quiet = logger.child({ module: 'test' }, { level: 'silent' });

const monitoring: ResolvedMonitoring = {
  enabled: true,
  clearBelow: 0.9,
  cooldownMs: 60_000,
  thresholds: { cpu: { warning: 100, forMs: 0, unit: 'percent' } },
};

/** Provider stub: `sample()` returns whatever the test queued, counting calls. */
function fakeProvider(sample: () => Promise<ProviderSample | null>): Provider<unknown> {
  return {
    type: 'fake',
    label: 'Fake',
    description: 'test provider',
    // Only the fields the monitor actually touches are populated.
    configSchema: { parse: (value: unknown) => value } as never,
    actions: () => [],
    status: async () => ({ state: 'running' }),
    runAction: async () => ({ ok: true, message: 'ok' }),
    supportsLogs: () => false,
    sample,
  };
}

function queued(samples: (ProviderSample | null)[], calls: { count: number }): Provider<unknown> {
  return fakeProvider(async () => {
    calls.count += 1;
    return samples.shift() ?? null;
  });
}

function target(
  provider: Provider<unknown>,
  options: { id?: string; monitoring?: ResolvedMonitoring; busy?: boolean } = {},
): MonitorTarget {
  const id = options.id ?? 'svc';
  const resolved = options.monitoring ?? monitoring;
  return {
    service: { id, name: id.toUpperCase(), monitoring: resolved } as unknown as ResolvedService,
    provider,
    monitoring: resolved,
    busy: options.busy ?? false,
    context: () => ({ service: { id }, config: {}, log: quiet }) as unknown as ProviderContext<unknown>,
  };
}

function collect(targets: MonitorTarget[]): { results: MonitorResult[]; host: MonitorHost } {
  const results: MonitorResult[] = [];
  return {
    results,
    host: {
      monitorTargets: () => targets,
      applyMonitorResult: (result) => results.push(result),
    },
  };
}

describe('ResourceMonitor sampling', () => {
  it('needs two readings before it can report a rate', async () => {
    const calls = { count: 0 };
    const targets = [
      target(
        queued(
          [
            { attribution: 'test', memoryBytes: 1_000, counters: { cpuNanos: 0 } },
            { attribution: 'test', memoryBytes: 1_000, counters: { cpuNanos: 1e9 } },
          ],
          calls,
        ),
      ),
    ];
    const { results, host } = collect(targets);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);

    await monitor.tick(0);
    assert.equal(results[0]?.sample?.cpuPercent, undefined);
    assert.equal(results[0]?.sample?.memoryBytes, 1_000);

    await monitor.tick(1_000);
    assert.equal(results[1]?.sample?.cpuPercent, 100);
  });

  it('does not sample a service with an action in flight, and keeps its sample', async () => {
    const calls = { count: 0 };
    const { results, host } = collect([target(queued([{ attribution: 'test', memoryBytes: 1 }], calls), { busy: true })]);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);

    await monitor.tick(0);
    assert.equal(calls.count, 0, 'provider must not be asked while an action runs');
    // No state change and nothing to report, so the host is not called at all —
    // in particular the stored sample is not overwritten with null.
    assert.deepEqual(results, []);
  });

  it('drops counter state across an action so the gap is not spread over one delta', async () => {
    const calls = { count: 0 };
    const targets = [
      target(
        queued(
          [
            { attribution: 'test', counters: { cpuNanos: 0 } },
            { attribution: 'test', counters: { cpuNanos: 500e9 } },
          ],
          calls,
        ),
      ),
    ];
    const { results, host } = collect(targets);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);

    await monitor.tick(0);
    const busyTarget = targets[0];
    assert.ok(busyTarget);
    busyTarget.busy = true;
    await monitor.tick(1_000); // restart in progress
    busyTarget.busy = false;
    await monitor.tick(2_000);

    // The reading after the restart has no predecessor, so the counter jump does
    // not become an absurd rate.
    assert.equal(results.at(-1)?.sample?.cpuPercent, undefined);
  });

  it('reports null when the provider has nothing to measure', async () => {
    const { results, host } = collect([target(queued([null], { count: 0 }))]);
    await new ResourceMonitor(host, { intervalMs: 1_000 }, quiet).tick(0);
    assert.equal(results[0]?.sample, null);
  });

  it('keeps the last reading when a sampling attempt fails', async () => {
    let mode: 'ok' | 'throw' = 'ok';
    const { results, host } = collect([
      target(
        fakeProvider(async () => {
          if (mode === 'throw') throw new Error('docker stats timed out');
          return { attribution: 'test', memoryBytes: 4_096 };
        }),
      ),
    ]);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);

    await monitor.tick(0);
    assert.equal(results[0]?.sample?.memoryBytes, 4_096);

    // A failed tick must not publish a sample at all: `undefined` tells the
    // manager to keep what it has, where `null` would blank the card.
    mode = 'throw';
    await monitor.tick(1_000);
    for (const result of results.slice(1)) {
      assert.equal(result.sample, undefined, 'a failed sample must leave the stored one alone');
    }
  });

  it('survives a throwing provider on the very first tick', async () => {
    const { results, host } = collect([
      target(
        fakeProvider(async () => {
          throw new Error('docker exploded');
        }),
      ),
    ]);
    await new ResourceMonitor(host, { intervalMs: 1_000 }, quiet).tick(0);
    // Nothing to store and no alert state to change, but the failure itself is
    // reported: the manager records the transition into and out of it.
    assert.equal(results.length, 1);
    assert.equal(results[0]?.error, 'docker exploded');
    assert.equal(results[0]?.sample, undefined);
    assert.deepEqual(results[0]?.events, []);
  });

  it('skips services whose monitoring is switched off', async () => {
    const calls = { count: 0 };
    const { host } = collect([
      target(queued([{ attribution: 'x' }], calls), { monitoring: { ...monitoring, enabled: false } }),
    ]);
    await new ResourceMonitor(host, { intervalMs: 1_000 }, quiet).tick(0);
    assert.equal(calls.count, 0);
  });

  it('never runs two ticks at once', async () => {
    const calls = { count: 0 };
    const { host } = collect([
      target(
        fakeProvider(async () => {
          calls.count += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { attribution: 'slow' };
        }),
      ),
    ]);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);
    await Promise.all([monitor.tick(0), monitor.tick(0)]);
    assert.equal(calls.count, 1);
  });

  it('evaluates alerts on elapsed time, not on the number of ticks', async () => {
    const withFor: ResolvedMonitoring = {
      ...monitoring,
      thresholds: { cpu: { warning: 100, forMs: 30_000, unit: 'percent' } },
    };
    const busy = () => fakeProvider(async () => ({ attribution: 'test', cpuPercent: 150 }));

    const slow = collect([target(busy(), { monitoring: withFor })]);
    const slowMonitor = new ResourceMonitor(slow.host, { intervalMs: 30_000 }, quiet);
    await slowMonitor.tick(0);
    await slowMonitor.tick(30_000);

    const fast = collect([target(busy(), { monitoring: withFor })]);
    const fastMonitor = new ResourceMonitor(fast.host, { intervalMs: 1_000 }, quiet);
    for (let at = 0; at <= 30_000; at += 1_000) await fastMonitor.tick(at);

    const slowEvents = slow.results.flatMap((result) => result.events);
    const fastEvents = fast.results.flatMap((result) => result.events);
    assert.equal(slowEvents.length, 1);
    assert.equal(fastEvents.length, 1);
    assert.equal(slowEvents[0]?.alert.activatedAt, fastEvents[0]?.alert.activatedAt);
  });

  it('keeps counters per service', async () => {
    const calls = { count: 0 };
    const { results, host } = collect([
      target(queued([{ attribution: 'a', counters: { cpuNanos: 0 } }, { attribution: 'a', counters: { cpuNanos: 1e9 } }], calls), { id: 'a' }),
      target(queued([{ attribution: 'b', counters: { cpuNanos: 5e9 } }, { attribution: 'b', counters: { cpuNanos: 5e9 } }], calls), { id: 'b' }),
    ]);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);

    await monitor.tick(0);
    await monitor.tick(1_000);

    const rated = results.filter((result) => result.sample?.cpuPercent !== undefined);
    assert.equal(rated.find((result) => result.id === 'a')?.sample?.cpuPercent, 100);
    assert.equal(rated.find((result) => result.id === 'b')?.sample?.cpuPercent, 0);
  });

  it('clears alerts for a service that disappeared from the config', async () => {
    const targets = [target(fakeProvider(async () => ({ attribution: 'test', cpuPercent: 150 })), { id: 'gone' })];
    const { results, host } = collect(targets);
    const monitor = new ResourceMonitor(host, { intervalMs: 1_000 }, quiet);
    await monitor.tick(0);
    assert.equal(results.at(-1)?.events[0]?.kind, 'activated');

    targets.length = 0;
    await monitor.tick(1_000);
    const last = results.at(-1);
    assert.equal(last?.id, 'gone');
    assert.equal(last?.events[0]?.kind, 'cleared');
    assert.deepEqual(last?.alerts, []);
  });
});

describe('SampleBatch', () => {
  const statsLine =
    '{"ID":"abc","Name":"one","CPUPerc":"5%","MemUsage":"10MiB / 1GiB","NetIO":"1kB / 2kB","BlockIO":"0B / 0B"}';

  function fakeExec(counter: { count: number }, stdout: string) {
    return async (): Promise<ExecResult> => {
      counter.count += 1;
      return {
        argv: ['docker'],
        code: 0,
        signal: null,
        stdout,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
        ok: true,
      };
    };
  }

  it('runs docker stats once per tick, however many services ask', async () => {
    const counter = { count: 0 };
    const batch = new SampleBatch(quiet);
    const exec = fakeExec(counter, statsLine);
    const [first, second, third] = await Promise.all([
      batch.dockerStats('docker', exec),
      batch.dockerStats('docker', exec),
      batch.dockerStats('docker', exec),
    ]);
    assert.equal(counter.count, 1);
    assert.equal(first?.get('one')?.cpuPercent, 5);
    assert.equal(second, first);
    assert.equal(third, first);
  });

  it('separates batches per docker binary', async () => {
    const counter = { count: 0 };
    const batch = new SampleBatch(quiet);
    const exec = fakeExec(counter, statsLine);
    await batch.dockerStats('docker', exec);
    await batch.dockerStats('/usr/local/bin/docker', exec);
    assert.equal(counter.count, 2);
  });

  it('reports a failed docker call as an error, not as "no containers"', async () => {
    const batch = new SampleBatch(quiet);
    const throwing = async (): Promise<ExecResult> => {
      throw new Error('no docker');
    };
    await assert.rejects(() => batch.dockerStats('docker', throwing), /monitor:docker-stats failed/);
    await assert.rejects(() => batch.composeContainers('docker', throwing), /monitor:docker-ps failed/);

    // A non-zero exit is a failure too — an empty map would be read as "this
    // container is not running" and would clear the service's numbers.
    const failing = async (): Promise<ExecResult> => ({
      argv: ['docker'],
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon',
      durationMs: 1,
      timedOut: false,
      truncated: false,
      ok: false,
    });
    await assert.rejects(() => new SampleBatch(quiet).dockerStats('docker', failing), /exit 1/);
  });
});
