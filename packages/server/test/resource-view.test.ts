import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildResourceView,
  sortByMetric,
  sortBySeverity,
  type ResourceViewInput,
} from '../src/core/resource-view.js';
import type { ResolvedMonitoring } from '../src/config/monitoring.js';
import type { ResourceAlert } from '../src/core/alerts.js';

const NOW = Date.parse('2026-08-13T12:00:00.000Z');

const monitoring: ResolvedMonitoring = {
  enabled: true,
  clearBelow: 0.9,
  cooldownMs: 300_000,
  thresholds: {
    cpu: { warning: 15, critical: 100, forMs: 30_000, unit: 'percent' },
    memory: { warning: 402_653_184, critical: 805_306_368, forMs: 60_000, unit: 'bytes' },
  },
};

function input(overrides: Partial<ResourceViewInput> = {}): ResourceViewInput {
  return {
    id: 'antivirus',
    name: 'Antivirus',
    type: 'systemd',
    providerLabel: 'systemd',
    group: 'infrastructure',
    state: 'running',
    monitored: true,
    busy: false,
    monitoring,
    sample: {
      at: new Date(NOW - 5_000).toISOString(),
      attribution: 'systemd cgroup — the unit and all processes it spawned',
      cpuPercent: 3.92,
      memoryBytes: 332_079_104,
    },
    alerts: [],
    pending: {},
    historySamples: 42,
    now: NOW,
    ...overrides,
  };
}

function metric(view: ReturnType<typeof buildResourceView>, name: string) {
  return view.metrics.find((entry) => entry.metric === name);
}

describe('buildResourceView', () => {
  it('carries value, unit, thresholds and percentage of threshold', () => {
    const view = buildResourceView(input());
    const cpu = metric(view, 'cpu');
    assert.equal(cpu?.value, 3.92);
    assert.equal(cpu?.unit, 'percent');
    assert.equal(cpu?.warning, 15);
    assert.equal(cpu?.critical, 100);
    assert.equal(cpu?.forMs, 30_000);
    assert.equal(cpu?.percentOfWarning, 26.1);
    assert.equal(cpu?.state, 'ok');
  });

  it('reports sample age and attribution', () => {
    const view = buildResourceView(input());
    assert.equal(view.ageMs, 5_000);
    assert.match(view.attribution ?? '', /systemd cgroup/);
    assert.equal(view.sampling, 'ok');
  });

  it('lists unmeasured metrics instead of reporting them as zero', () => {
    const view = buildResourceView(input());
    assert.deepEqual(view.unmeasured, ['diskRead', 'diskWrite', 'netRx', 'netTx']);
    for (const name of view.unmeasured) {
      assert.equal(metric(view, name)?.value, undefined);
    }
  });

  it('keeps a threshold on an unmeasured metric visible as inert', () => {
    const view = buildResourceView(
      input({
        monitoring: {
          ...monitoring,
          thresholds: { ...monitoring.thresholds, netRx: { warning: 2_097_152, forMs: 60_000, unit: 'bytesPerSecond' } },
        },
      }),
    );
    const netRx = metric(view, 'netRx');
    assert.equal(netRx?.state, 'unmeasured');
    assert.equal(netRx?.warning, 2_097_152);
    assert.equal(netRx?.value, undefined);
  });

  it('marks a metric with no threshold as no-threshold', () => {
    const view = buildResourceView(input({ monitoring: { ...monitoring, thresholds: {} } }));
    assert.equal(metric(view, 'cpu')?.state, 'no-threshold');
    assert.equal(metric(view, 'cpu')?.percentOfWarning, undefined);
  });

  it('reports a breach still inside its `for` window as pending, with timing', () => {
    const view = buildResourceView(
      input({
        sample: {
          at: new Date(NOW).toISOString(),
          attribution: 'systemd cgroup',
          cpuPercent: 40,
        },
        pending: { cpu: { severity: 'warning', since: NOW - 12_000 } },
      }),
    );
    const cpu = metric(view, 'cpu');
    assert.equal(cpu?.state, 'pending');
    assert.equal(cpu?.pendingSeverity, 'warning');
    assert.equal(cpu?.breachingForMs, 12_000);
    assert.equal(cpu?.activatesInMs, 18_000);
    assert.equal(view.worst, 'pending');
  });

  it('lets an active alert decide the state, over any pending crossing', () => {
    const alert: ResourceAlert = {
      key: 'antivirus:cpu',
      serviceId: 'antivirus',
      serviceName: 'Antivirus',
      metric: 'cpu',
      label: 'CPU',
      unit: 'percent',
      severity: 'critical',
      value: 412,
      threshold: 100,
      breachedAt: new Date(NOW - 130_000).toISOString(),
      activatedAt: new Date(NOW - 100_000).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      active: true,
    };
    const view = buildResourceView(
      input({
        sample: { at: new Date(NOW).toISOString(), attribution: 'systemd cgroup', cpuPercent: 412 },
        alerts: [alert],
        pending: { cpu: { severity: 'critical', since: NOW - 130_000 } },
      }),
    );
    const cpu = metric(view, 'cpu');
    assert.equal(cpu?.state, 'critical');
    assert.equal(cpu?.alertKey, 'antivirus:cpu');
    assert.equal(view.worst, 'critical');
  });

  it('derives the memory limit percentage when a limit is reported', () => {
    const view = buildResourceView(
      input({
        sample: {
          at: new Date(NOW).toISOString(),
          attribution: 'docker stats — container cgroup',
          memoryBytes: 512,
          memoryLimitBytes: 2_048,
        },
      }),
    );
    assert.deepEqual(view.memory, { bytes: 512, limitBytes: 2_048, percentOfLimit: 25 });
  });

  it('ignores a zero memory limit rather than dividing by it', () => {
    const view = buildResourceView(
      input({
        sample: {
          at: new Date(NOW).toISOString(),
          attribution: 'x',
          memoryBytes: 512,
          memoryLimitBytes: 0,
        },
      }),
    );
    assert.deepEqual(view.memory, { bytes: 512 });
  });

  it('adds the per-child memory limit percentage for compose stacks', () => {
    const view = buildResourceView(
      input({
        type: 'compose',
        sample: {
          at: new Date(NOW).toISOString(),
          attribution: 'docker stats — sum over 2 container(s)',
          cpuPercent: 7.7,
          children: [
            { id: 'a', name: 'web', cpuPercent: 3, memoryBytes: 256, memoryLimitBytes: 1_024 },
            { id: 'b', name: 'db', cpuPercent: 4.7, memoryBytes: 512 },
          ],
        },
      }),
    );
    assert.equal(view.children?.[0]?.percentOfMemoryLimit, 25);
    assert.equal(view.children?.[1]?.percentOfMemoryLimit, undefined);
  });

  it('explains why numbers are missing', () => {
    assert.equal(buildResourceView(input({ monitored: false })).sampling, 'off');
    assert.equal(buildResourceView(input({ busy: true })).sampling, 'paused');
    assert.equal(
      buildResourceView(input({ sample: null, state: 'stopped' })).sampling,
      'no-sample',
    );
  });

  it('omits sample fields entirely when there is no sample', () => {
    const view = buildResourceView(input({ sample: null, state: 'stopped' }));
    assert.equal(view.sampledAt, undefined);
    assert.equal(view.ageMs, undefined);
    assert.equal(view.attribution, undefined);
    assert.equal(view.memory, undefined);
    assert.equal(view.worst, 'unmeasured');
  });
});

describe('ordering', () => {
  const hot = buildResourceView(
    input({ id: 'hot', sample: { at: new Date(NOW).toISOString(), attribution: 'x', cpuPercent: 200 } }),
  );
  const warm = buildResourceView(
    input({ id: 'warm', sample: { at: new Date(NOW).toISOString(), attribution: 'x', cpuPercent: 5 } }),
  );
  const cold = buildResourceView(input({ id: 'cold', sample: null }));

  it('sorts by one metric, highest first, with unmeasured services last', () => {
    const sorted = sortByMetric([cold, warm, hot], 'cpu');
    assert.deepEqual(
      sorted.map((view) => view.id),
      ['hot', 'warm', 'cold'],
    );
  });

  it('sorts by worst threshold state by default', () => {
    const pending = buildResourceView(
      input({
        id: 'pending',
        sample: { at: new Date(NOW).toISOString(), attribution: 'x', cpuPercent: 40 },
        pending: { cpu: { severity: 'warning', since: NOW - 1_000 } },
      }),
    );
    const sorted = sortBySeverity([cold, warm, pending]);
    assert.deepEqual(
      sorted.map((view) => view.id),
      ['pending', 'warm', 'cold'],
    );
  });
});
