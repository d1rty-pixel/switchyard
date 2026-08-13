import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  deriveRates,
  resourceDigest,
  sumCounters,
  sumGauge,
  type ResourceSample,
} from '../src/core/resources.js';
import { findStatsRow, indexStats, parseComposePs, parseDockerStats, splitPair } from '../src/core/sample-batch.js';

describe('deriveRates: CPU counter deltas', () => {
  it('turns a nanosecond counter into a percentage', () => {
    // 1 s of CPU time over 1 s of wall clock = one busy core = 100 %.
    assert.equal(deriveRates({ cpuNanos: 0 }, { cpuNanos: 1e9 }, 1_000).cpuPercent, 100);
    // 3 s of CPU over 1 s means three cores were busy.
    assert.equal(deriveRates({ cpuNanos: 0 }, { cpuNanos: 3e9 }, 1_000).cpuPercent, 300);
    // Half a second of CPU over 10 s.
    assert.equal(deriveRates({ cpuNanos: 1e9 }, { cpuNanos: 1.5e9 }, 10_000).cpuPercent, 5);
  });

  it('reports nothing rather than a negative rate after a counter reset', () => {
    const values = deriveRates({ cpuNanos: 5e9, netRxBytes: 900 }, { cpuNanos: 1e9, netRxBytes: 100 }, 1_000);
    assert.equal(values.cpuPercent, undefined);
    assert.equal(values.netRxBps, undefined);
  });

  it('reports nothing for a zero or negative time delta', () => {
    assert.deepEqual(deriveRates({ cpuNanos: 0 }, { cpuNanos: 1e9 }, 0), {});
    assert.deepEqual(deriveRates({ cpuNanos: 0 }, { cpuNanos: 1e9 }, -5_000), {});
  });

  it('leaves a metric absent when either reading lacks it', () => {
    const values = deriveRates({ cpuNanos: 0 }, { cpuNanos: 1e9, diskReadBytes: 10 }, 1_000);
    assert.equal(values.cpuPercent, 100);
    assert.equal(values.diskReadBps, undefined);
  });

  it('derives byte rates per second', () => {
    const values = deriveRates(
      { diskReadBytes: 0, diskWriteBytes: 0, netRxBytes: 0, netTxBytes: 0 },
      { diskReadBytes: 2_000, diskWriteBytes: 500, netRxBytes: 10_000, netTxBytes: 1 },
      2_000,
    );
    assert.equal(values.diskReadBps, 1_000);
    assert.equal(values.diskWriteBps, 250);
    assert.equal(values.netRxBps, 5_000);
    assert.equal(values.netTxBps, 1);
  });
});

describe('aggregation', () => {
  it('sums counters and gauges, keeping unreported metrics absent', () => {
    const units = [
      { cpuPercent: 1.5, memoryBytes: 100, counters: { cpuNanos: 10, netRxBytes: 5 } },
      { cpuPercent: 2.5, counters: { cpuNanos: 20 } },
    ];
    assert.equal(sumGauge(units, 'cpuPercent'), 4);
    assert.equal(sumGauge(units, 'memoryBytes'), 100);
    assert.deepEqual(sumCounters(units), { cpuNanos: 30, netRxBytes: 5 });
    assert.equal(sumGauge([{}], 'memoryBytes'), undefined);
    assert.equal(sumCounters([{}]), undefined);
  });
});

describe('resourceDigest', () => {
  const base: ResourceSample = { at: '2026-01-01T00:00:00.000Z', attribution: 'test', cpuPercent: 30, memoryBytes: 1_000_000 };

  it('ignores noise so the dashboard is not updated for every sample', () => {
    assert.equal(resourceDigest(base), resourceDigest({ ...base, cpuPercent: 31, memoryBytes: 1_100_000 }));
    // The timestamp alone must never make a sample look different.
    assert.equal(resourceDigest(base), resourceDigest({ ...base, at: '2026-01-01T00:00:15.000Z' }));
  });

  it('changes when the load really moves', () => {
    assert.notEqual(resourceDigest(base), resourceDigest({ ...base, cpuPercent: 300 }));
    assert.notEqual(resourceDigest(base), resourceDigest({ ...base, memoryBytes: 4 * 1024 ** 3 }));
    assert.notEqual(resourceDigest(base), resourceDigest(null));
  });
});

describe('docker stats parsing', () => {
  const line =
    '{"BlockIO":"37.9MB / 6.54MB","CPUPerc":"1.55%","Container":"03311fdf2eca","ID":"03311fdf2eca",' +
    '"MemPerc":"0.09%","MemUsage":"28.92MiB / 30.27GiB","Name":"demo-stack-postgres-1","NetIO":"999kB / 717kB","PIDs":"7"}';

  it('reads the fields it needs and leaves the rest alone', () => {
    const [row] = parseDockerStats(line);
    assert.ok(row);
    assert.equal(row.name, 'demo-stack-postgres-1');
    assert.equal(row.cpuPercent, 1.55);
    assert.equal(row.memoryBytes, Math.round(28.92 * 1024 ** 2));
    assert.equal(row.memoryLimitBytes, Math.round(30.27 * 1024 ** 3));
    assert.deepEqual(row.counters, {
      netRxBytes: 999_000,
      netTxBytes: 717_000,
      diskReadBytes: 37_900_000,
      diskWriteBytes: 6_540_000,
    });
  });

  it('skips malformed lines instead of failing the whole tick', () => {
    assert.equal(parseDockerStats(`not json\n${line}\n\n{}`).length, 1);
  });

  it('handles the placeholder values of a container without stats', () => {
    assert.deepEqual(splitPair('-- / --'), [undefined, undefined]);
    assert.deepEqual(splitPair(undefined), [undefined, undefined]);
    assert.deepEqual(splitPair('0B / 49.2kB'), [0, 49_200]);
  });

  it('indexes rows by name, full id and short id', () => {
    const index = indexStats([
      { id: 'a'.repeat(64), name: 'traefik', counters: {} },
    ]);
    assert.ok(index.get('traefik'));
    assert.ok(index.get('a'.repeat(64)));
    assert.ok(index.get('a'.repeat(12)));
    assert.equal(index.get('nope'), undefined);
  });

  it('finds a container by name, id or id prefix', () => {
    const index = indexStats([{ id: 'abcdef123456789', name: 'traefik', counters: {} }]);
    assert.ok(findStatsRow(index, 'traefik'));
    assert.ok(findStatsRow(index, 'abcdef123456789'));
    assert.ok(findStatsRow(index, 'abcdef'));
    assert.equal(findStatsRow(index, 'portainer'), undefined);
    assert.equal(findStatsRow(index, 'ffff'), undefined);
  });
});

describe('compose label parsing', () => {
  it('maps containers to their project and service', () => {
    const rows = parseComposePs(
      ['38d1b4cab243\tdemo-stack-api-1\tdemo-stack\tapi', 'bad-line', '5d0742cc4dba\tsolo\t\t'].join('\n'),
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { id: '38d1b4cab243', name: 'demo-stack-api-1', project: 'demo-stack', service: 'api' });
  });
});
