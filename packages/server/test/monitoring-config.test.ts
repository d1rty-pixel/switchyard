import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  globalMonitoringSchema,
  resolveGlobalMonitoring,
  resolveServiceMonitoring,
  serviceMonitoringSchema,
  MONITORING_DEFAULTS,
  MIN_INTERVAL_MS,
} from '../src/config/monitoring.js';

function parseGlobal(input: unknown) {
  const result = globalMonitoringSchema.safeParse(input);
  assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues));
  return resolveGlobalMonitoring(result.data);
}

function parseService(input: unknown) {
  const result = serviceMonitoringSchema.safeParse(input);
  assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues));
  return result.data;
}

describe('monitoring configuration', () => {
  it('applies defaults when the block is absent', () => {
    const global = parseGlobal(undefined);
    assert.equal(global.enabled, true);
    assert.equal(global.intervalMs, MONITORING_DEFAULTS.intervalMs);
    assert.equal(global.clearBelow, 0.9);
    assert.deepEqual(global.thresholds, {});
  });

  it('reads human-readable units', () => {
    const global = parseGlobal({ interval: '15s', for: '30s', cooldown: '5m', clearBelow: 0.8 });
    assert.equal(global.intervalMs, 15_000);
    assert.equal(global.forMs, 30_000);
    assert.equal(global.cooldownMs, 300_000);
    assert.equal(global.clearBelow, 0.8);
  });

  it('clamps an absurdly fast interval instead of spawning processes in a loop', () => {
    assert.equal(parseGlobal({ interval: '10ms' }).intervalMs, MIN_INTERVAL_MS);
  });

  it('rejects invalid values rather than guessing', () => {
    for (const input of [
      { interval: '15' },
      { cpu: { warning: '150' } },
      { memory: { warning: '2' } },
      { diskWrite: { warning: '50MiB' } },
      { cpu: {} },
      { cpu: { warning: '400%', critical: '150%' } },
      { clearBelow: 0 },
      { clearBelow: 2 },
      { unknownKey: true },
      { cpu: { warning: '150%', nope: 1 } },
    ]) {
      const result = globalMonitoringSchema.safeParse(input);
      assert.equal(result.success, false, `should reject ${JSON.stringify(input)}`);
    }
  });

  it('keeps thresholds in their metric-appropriate units', () => {
    const global = parseGlobal({
      cpu: { warning: '150%', critical: '400%' },
      memory: { warning: '2GiB' },
      diskWrite: { warning: '50MiB/s' },
    });
    assert.equal(global.thresholds.cpu?.warning, 150);
    assert.equal(global.thresholds.cpu?.critical, 400);
    assert.equal(global.thresholds.memory?.warning, 2 * 1024 ** 3);
    assert.equal(global.thresholds.diskWrite?.warning, 50 * 1024 ** 2);
  });

  it('merges per-service thresholds over the global ones', () => {
    const global = parseGlobal({ for: '1m', cpu: { warning: '100%', critical: '200%' } });
    const resolved = resolveServiceMonitoring(global, parseService({ cpu: { warning: '150%', for: '30s' } }));

    // The service block replaces the metric wholesale — no invisible inherited
    // critical from a file the author is not looking at.
    assert.equal(resolved.thresholds.cpu?.warning, 150);
    assert.equal(resolved.thresholds.cpu?.critical, undefined);
    assert.equal(resolved.thresholds.cpu?.forMs, 30_000);
  });

  it('inherits global thresholds and the global for-duration untouched', () => {
    const global = parseGlobal({ for: '1m', memory: { warning: '1GiB' } });
    const resolved = resolveServiceMonitoring(global, parseService({ cpu: { warning: '50%' } }));
    assert.equal(resolved.thresholds.memory?.warning, 1024 ** 3);
    assert.equal(resolved.thresholds.memory?.forMs, 60_000);
    // A service-level `for` applies to inherited metrics too.
    const withOwnFor = resolveServiceMonitoring(global, parseService({ for: '10s' }));
    assert.equal(withOwnFor.thresholds.memory?.forMs, 10_000);
  });

  it('lets a service opt out, and the global switch win over a service opt-in', () => {
    const on = parseGlobal({});
    assert.equal(resolveServiceMonitoring(on, parseService({ enabled: false })).enabled, false);
    const off = parseGlobal({ enabled: false });
    assert.equal(resolveServiceMonitoring(off, parseService({ enabled: true })).enabled, false);
  });

  it('keeps monitoring optional: no thresholds means sampling without alerts', () => {
    const resolved = resolveServiceMonitoring(parseGlobal(undefined), parseService(undefined));
    assert.equal(resolved.enabled, true);
    assert.deepEqual(resolved.thresholds, {});
  });
});
