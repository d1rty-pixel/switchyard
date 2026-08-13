import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bucketSamples,
  metricStats,
  MAX_HISTORY_SAMPLES,
  ResourceHistory,
  type HistorySample,
} from '../src/core/resource-history.js';
import type { ResolvedThreshold } from '../src/config/monitoring.js';

const T0 = Date.parse('2026-08-13T12:00:00.000Z');

function at(seconds: number): number {
  return T0 + seconds * 1_000;
}

/** Builds a series of `count` samples, `stepSeconds` apart, with the given CPU values. */
function cpuSeries(values: number[], stepSeconds = 15): HistorySample[] {
  return values.map((value, index) => ({ at: at(index * stepSeconds), values: { cpuPercent: value } }));
}

describe('ResourceHistory', () => {
  it('retains samples inside the window and drops older ones', () => {
    const history = new ResourceHistory(60_000);
    history.append('svc', at(0), { cpuPercent: 1 });
    history.append('svc', at(30), { cpuPercent: 2 });
    // Appending at t+90s puts the first sample outside the 60 s window.
    history.append('svc', at(90), { cpuPercent: 3 });

    const samples = history.samples('svc');
    assert.deepEqual(
      samples.map((sample) => sample.values.cpuPercent),
      [2, 3],
    );
  });

  it('enforces the hard sample cap regardless of retention', () => {
    const history = new ResourceHistory(86_400_000);
    for (let index = 0; index < MAX_HISTORY_SAMPLES + 50; index += 1) {
      history.append('svc', at(index * 2), { cpuPercent: index });
    }
    assert.equal(history.size('svc'), MAX_HISTORY_SAMPLES);
    // The newest readings are the ones kept.
    const samples = history.samples('svc');
    assert.equal(samples[samples.length - 1]?.values.cpuPercent, MAX_HISTORY_SAMPLES + 49);
  });

  it('ignores samples that carry no measured value', () => {
    const history = new ResourceHistory(60_000);
    history.append('svc', at(0), {});
    assert.equal(history.size('svc'), 0);
  });

  it('keeps only the six known metric fields', () => {
    const history = new ResourceHistory(60_000);
    history.append('svc', at(0), { cpuPercent: 5, attribution: 'nope' } as never);
    assert.deepEqual(history.samples('svc')[0]?.values, { cpuPercent: 5 });
  });

  it('forgets a service completely', () => {
    const history = new ResourceHistory(60_000);
    history.append('svc', at(0), { cpuPercent: 1 });
    history.forget('svc');
    assert.equal(history.size('svc'), 0);
    assert.deepEqual(history.samples('svc'), []);
  });

  it('applies a shortened retention on reconfigure', () => {
    const history = new ResourceHistory(3_600_000);
    const now = Date.now();
    history.append('svc', now - 600_000, { cpuPercent: 1 });
    history.append('svc', now - 10_000, { cpuPercent: 2 });
    history.reconfigure(60_000);
    assert.equal(history.size('svc'), 1);
  });

  it('windows samples relative to now', () => {
    const history = new ResourceHistory(3_600_000);
    const now = Date.now();
    history.append('svc', now - 300_000, { cpuPercent: 1 });
    history.append('svc', now - 30_000, { cpuPercent: 2 });
    assert.equal(history.samples('svc', 60_000, now).length, 1);
    assert.equal(history.samples('svc', 600_000, now).length, 2);
  });
});

describe('metricStats', () => {
  const thresholds: Partial<Record<'cpu' | 'memory', ResolvedThreshold>> = {
    cpu: { warning: 10, critical: 20, forMs: 30_000, unit: 'percent' },
  };

  it('summarises one metric', () => {
    const stats = metricStats(cpuSeries([2, 4, 6, 8, 30]), thresholds);
    const cpu = stats.find((entry) => entry.metric === 'cpu');
    assert.ok(cpu);
    assert.equal(cpu.samples, 5);
    assert.equal(cpu.min, 2);
    assert.equal(cpu.max, 30);
    assert.equal(cpu.average, 10);
    assert.equal(cpu.latest, 30);
    assert.equal(cpu.spanMs, 60_000);
  });

  it('reports the nearest-rank p95, never interpolated', () => {
    const stats = metricStats(cpuSeries([1, 2, 3, 4, 100]), thresholds);
    assert.equal(stats[0]?.p95, 100);
  });

  it('counts the share of samples at or above each threshold', () => {
    // 10 is exactly the warning threshold and must count: the alert machine
    // breaches at `value >= limit`.
    const stats = metricStats(cpuSeries([1, 10, 25, 25]), thresholds);
    const cpu = stats[0];
    assert.equal(cpu?.fractionAboveWarning, 0.75);
    assert.equal(cpu?.fractionAboveCritical, 0.5);
  });

  it('omits threshold fractions for metrics with no threshold', () => {
    const stats = metricStats(cpuSeries([1, 2]), {});
    assert.equal(stats[0]?.fractionAboveWarning, undefined);
    assert.equal(stats[0]?.warning, undefined);
  });

  it('skips metrics that were never measured instead of reporting zero', () => {
    const stats = metricStats(cpuSeries([1, 2]), thresholds);
    assert.deepEqual(
      stats.map((entry) => entry.metric),
      ['cpu'],
    );
  });

  it('handles a single sample', () => {
    const stats = metricStats(cpuSeries([7]), thresholds);
    assert.equal(stats[0]?.samples, 1);
    assert.equal(stats[0]?.spanMs, 0);
    assert.equal(stats[0]?.p95, 7);
  });
});

describe('bucketSamples', () => {
  it('returns at most the requested number of buckets whatever the window', () => {
    const samples = cpuSeries(Array.from({ length: 500 }, (_, index) => index), 2);
    const buckets = bucketSamples(samples, 30, at(0), at(1_000));
    assert.ok(buckets.length <= 30);
  });

  it('averages and peaks per bucket', () => {
    const samples = cpuSeries([2, 4, 100, 100], 10);
    const buckets = bucketSamples(samples, 2, at(0), at(40));
    assert.equal(buckets.length, 2);
    assert.deepEqual(buckets[0]?.values.cpu, { average: 3, max: 4 });
    assert.equal(buckets[0]?.samples, 2);
    assert.deepEqual(buckets[1]?.values.cpu, { average: 100, max: 100 });
  });

  it('skips empty buckets rather than inventing zeroes', () => {
    const samples = cpuSeries([5], 10);
    const buckets = bucketSamples(samples, 4, at(0), at(40));
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]?.samples, 1);
  });

  it('includes the newest sample, which sits on the upper bound', () => {
    const samples: HistorySample[] = [{ at: at(40), values: { cpuPercent: 9 } }];
    const buckets = bucketSamples(samples, 4, at(0), at(40));
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]?.values.cpu?.max, 9);
  });

  it('leaves a metric out of a bucket when nothing measured it', () => {
    const samples: HistorySample[] = [
      { at: at(0), values: { cpuPercent: 1 } },
      { at: at(1), values: { memoryBytes: 100 } },
    ];
    const buckets = bucketSamples(samples, 1, at(0), at(10));
    assert.ok(buckets[0]?.values.cpu);
    assert.ok(buckets[0]?.values.memory);
    assert.equal(buckets[0]?.values.netRx, undefined);
  });

  it('returns nothing for an empty series or a degenerate window', () => {
    assert.deepEqual(bucketSamples([], 10, at(0), at(10)), []);
    assert.deepEqual(bucketSamples(cpuSeries([1]), 10, at(10), at(10)), []);
  });
});
