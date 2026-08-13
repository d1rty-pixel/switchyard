import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatAge,
  formatAlert,
  formatBytes,
  formatDuration,
  formatFraction,
  formatMetric,
  formatValue,
  samplingNote,
  stateMarker,
  table,
} from '../src/format.js';
import type { ResourceAlert, ResourceMetricView, ServiceResourceView } from '../src/wire.js';

describe('value formatting', () => {
  it('scales bytes to binary units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1_024), '1 KiB');
    assert.equal(formatBytes(332_079_104), '317 MiB');
    assert.equal(formatBytes(1_826_800_795), '1.7 GiB');
  });

  it('renders each metric in its own unit', () => {
    assert.equal(formatValue(3.92, 'percent'), '3.92%');
    assert.equal(formatValue(332_079_104, 'bytes'), '317 MiB');
    assert.equal(formatValue(1_048_576, 'bytesPerSecond'), '1 MiB/s');
  });

  it('formats durations without inventing precision', () => {
    assert.equal(formatDuration(450), '450ms');
    assert.equal(formatDuration(12_000), '12s');
    assert.equal(formatDuration(90_000), '1m 30s');
    assert.equal(formatDuration(3_600_000), '1h');
    assert.equal(formatDuration(3_900_000), '1h 5m');
    assert.equal(formatDuration(90_000_000), '1d 1h');
  });

  it('describes sample age, including the unknown case', () => {
    assert.equal(formatAge(undefined), 'never');
    assert.equal(formatAge(300), 'just now');
    assert.equal(formatAge(5_000), '5s ago');
  });

  it('turns sample shares into whole percents', () => {
    assert.equal(formatFraction(0.4), '40%');
    assert.equal(formatFraction(0), '0%');
    assert.equal(formatFraction(1), '100%');
  });
});

describe('formatMetric', () => {
  const base: ResourceMetricView = {
    metric: 'cpu',
    label: 'CPU',
    unit: 'percent',
    value: 3.92,
    state: 'ok',
    warning: 15,
    critical: 100,
    forMs: 30_000,
    percentOfWarning: 26.1,
  };

  it('shows headroom against the warning threshold', () => {
    assert.equal(formatMetric(base), 'cpu 3.92% (26.1% of warning 15%)');
  });

  it('marks an active alert with the threshold it crossed', () => {
    assert.equal(
      formatMetric({ ...base, value: 412, state: 'critical' }),
      'cpu 412% [CRITICAL ≥ 100%]',
    );
  });

  it('shows a pending breach with the time left before it alerts', () => {
    assert.equal(
      formatMetric({
        ...base,
        value: 40,
        state: 'pending',
        pendingSeverity: 'warning',
        breachingForMs: 12_000,
        activatesInMs: 18_000,
      }),
      'cpu 40% [over warning for 12s, alerts in 18s]',
    );
  });

  it('says a threshold cannot fire when the metric is not measurable', () => {
    assert.equal(
      formatMetric({
        metric: 'netRx',
        label: 'Net in',
        unit: 'bytesPerSecond',
        state: 'unmeasured',
        warning: 2_097_152,
        forMs: 60_000,
      }),
      'netRx — (no measurement; threshold warning 2 MiB/s cannot fire)',
    );
  });

  it('adds no threshold context when none is configured', () => {
    assert.equal(
      formatMetric({ metric: 'cpu', label: 'CPU', unit: 'percent', value: 7, state: 'no-threshold' }),
      'cpu 7%',
    );
  });
});

describe('samplingNote', () => {
  const view = (overrides: Partial<ServiceResourceView>): ServiceResourceView =>
    ({
      id: 'x',
      name: 'X',
      type: 'command',
      providerLabel: 'Command',
      group: 'other',
      state: 'running',
      monitored: true,
      sampling: 'ok',
      metrics: [],
      unmeasured: [],
      alerts: [],
      worst: 'ok',
      historySamples: 0,
      ...overrides,
    }) as ServiceResourceView;

  it('says nothing when sampling is healthy', () => {
    assert.equal(samplingNote(view({})), undefined);
  });

  it('explains a paused, stopped or unmonitored service', () => {
    assert.match(samplingNote(view({ sampling: 'paused' })) ?? '', /paused while an action runs/);
    assert.match(
      samplingNote(view({ sampling: 'no-sample', state: 'stopped' })) ?? '',
      /nothing to measure \(service is stopped\)/,
    );
    assert.match(samplingNote(view({ sampling: 'off', monitored: false })) ?? '', /sampling off/);
  });
});

describe('formatAlert', () => {
  it('reports value, threshold and how long the alert has been active', () => {
    const now = Date.parse('2026-08-13T12:00:00.000Z');
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
      breachedAt: '2026-08-13T11:57:50.000Z',
      activatedAt: '2026-08-13T11:58:20.000Z',
      updatedAt: '2026-08-13T12:00:00.000Z',
      active: true,
    };
    const text = formatAlert(alert, now);
    assert.match(text, /^CRITICAL antivirus cpu 412% ≥ 100% for 1m 40s/);
    assert.doesNotMatch(text, /STALE/);
    assert.match(formatAlert({ ...alert, stale: true }, now), /\[STALE — no fresh samples\]/);
  });
});

describe('stateMarker', () => {
  it('marks only the states worth noticing', () => {
    assert.equal(stateMarker('critical'), 'CRIT');
    assert.equal(stateMarker('warning'), 'WARN');
    assert.equal(stateMarker('pending'), 'PEND');
    assert.equal(stateMarker('ok'), '  ok');
    assert.equal(stateMarker('unmeasured'), '  ok');
  });
});

describe('table', () => {
  it('aligns columns and leaves no trailing whitespace', () => {
    const rendered = table(['ID', 'STATE'], [['a', 'running'], ['longer-id', 'stopped']]);
    const rows = rendered.split('\n');
    assert.equal(rows[0], 'ID         STATE');
    assert.equal(rows[1], 'a          running');
    for (const row of rows) assert.equal(row, row.trimEnd());
  });
});
