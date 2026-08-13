import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AlertTracker, type AlertEvent } from '../src/core/alerts.js';
import type { ResolvedMonitoring } from '../src/config/monitoring.js';
import type { ResourceValues } from '../src/core/resources.js';

const SECOND = 1_000;

function config(overrides: Partial<ResolvedMonitoring> = {}): ResolvedMonitoring {
  return {
    enabled: true,
    clearBelow: 0.9,
    cooldownMs: 5 * 60 * SECOND,
    thresholds: {
      cpu: { warning: 100, critical: 400, forMs: 30 * SECOND, unit: 'percent' },
    },
    ...overrides,
  };
}

/** Feeds a series of readings in and collects every event they produced. */
function run(
  tracker: AlertTracker,
  monitoring: ResolvedMonitoring,
  readings: { at: number; values: ResourceValues | null; paused?: boolean }[],
  staleAfterMs = 45 * SECOND,
): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const reading of readings) {
    events.push(
      ...tracker.evaluate({
        serviceId: 'antivirus',
        serviceName: 'Antivirus',
        values: reading.values,
        monitoring,
        now: reading.at,
        paused: reading.paused,
        staleAfterMs,
      }),
    );
  }
  return events;
}

/** Readings every `stepMs` from `from` to `to`, all with the same CPU value. */
function cpuSeries(from: number, to: number, stepMs: number, cpuPercent: number) {
  const readings: { at: number; values: ResourceValues }[] = [];
  for (let at = from; at <= to; at += stepMs) readings.push({ at, values: { cpuPercent } });
  return readings;
}

describe('sustained duration', () => {
  it('does not alert before the configured for-duration has elapsed', () => {
    const events = run(new AlertTracker(), config(), cpuSeries(0, 25 * SECOND, 5 * SECOND, 150));
    assert.deepEqual(events, []);
  });

  it('activates once the breach has lasted for the configured duration', () => {
    const events = run(new AlertTracker(), config(), cpuSeries(0, 30 * SECOND, 5 * SECOND, 150));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'activated');
    assert.equal(events[0]?.alert.severity, 'warning');
    assert.equal(events[0]?.alert.threshold, 100);
    assert.equal(events[0]?.notify, true);
    // The breach timestamp is when the value first crossed, not when it fired.
    assert.equal(events[0]?.alert.breachedAt, new Date(0).toISOString());
  });

  it('ignores a short spike', () => {
    const events = run(new AlertTracker(), config(), [
      { at: 0, values: { cpuPercent: 10 } },
      { at: 5 * SECOND, values: { cpuPercent: 900 } },
      { at: 10 * SECOND, values: { cpuPercent: 12 } },
      { at: 60 * SECOND, values: { cpuPercent: 10 } },
    ]);
    assert.deepEqual(events, []);
  });

  it('restarts the clock when the value dips below the threshold', () => {
    const events = run(new AlertTracker(), config(), [
      ...cpuSeries(0, 25 * SECOND, 5 * SECOND, 150),
      { at: 26 * SECOND, values: { cpuPercent: 10 } },
      ...cpuSeries(30 * SECOND, 50 * SECOND, 5 * SECOND, 150),
    ]);
    assert.deepEqual(events, []);
  });

  it('keeps for-semantics when the sampling interval changes', () => {
    // Same 30 s window, sampled every 15 s and every 3 s: identical outcome, and
    // in particular the coarse series is not delayed by "needing more samples".
    const coarse = run(new AlertTracker(), config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const fine = run(new AlertTracker(), config(), cpuSeries(0, 30 * SECOND, 3 * SECOND, 150));
    assert.equal(coarse.length, 1);
    assert.equal(fine.length, 1);
    assert.equal(coarse[0]?.alert.activatedAt, fine[0]?.alert.activatedAt);

    // Two samples 30 s apart are enough; twenty samples over 20 s are not.
    const twoSamples = run(new AlertTracker(), config(), [
      { at: 0, values: { cpuPercent: 150 } },
      { at: 30 * SECOND, values: { cpuPercent: 150 } },
    ]);
    assert.equal(twoSamples.length, 1);
    assert.equal(run(new AlertTracker(), config(), cpuSeries(0, 20 * SECOND, SECOND, 150)).length, 0);
  });
});

describe('deduplication', () => {
  it('emits nothing while an active alert simply continues', () => {
    const tracker = new AlertTracker();
    const events = run(tracker, config(), cpuSeries(0, 10 * 60 * SECOND, 15 * SECOND, 150));
    assert.equal(events.length, 1);
    assert.equal(tracker.activeFor('antivirus').length, 1);
    // The value is still kept current for the UI, without an event per sample.
    assert.equal(tracker.activeFor('antivirus')[0]?.value, 150);
  });
});

describe('hysteresis', () => {
  it('holds the alert between clearBelow and the threshold', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = run(tracker, config(), [{ at: 45 * SECOND, values: { cpuPercent: 95 } }]);
    assert.deepEqual(events, []);
    assert.equal(tracker.activeFor('antivirus').length, 1);
  });

  it('clears once the value drops below threshold * clearBelow', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = run(tracker, config(), [{ at: 45 * SECOND, values: { cpuPercent: 89 } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'cleared');
    assert.equal(events[0]?.alert.active, false);
    assert.ok(events[0]?.alert.clearedAt);
    assert.equal(tracker.activeFor('antivirus').length, 0);
  });

  it('does not flap while the value oscillates around the threshold', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = run(tracker, monitoring, [
      { at: 45 * SECOND, values: { cpuPercent: 99 } },
      { at: 60 * SECOND, values: { cpuPercent: 101 } },
      { at: 75 * SECOND, values: { cpuPercent: 95 } },
      { at: 90 * SECOND, values: { cpuPercent: 120 } },
    ]);
    assert.deepEqual(events, []);
  });
});

describe('escalation and recovery', () => {
  it('escalates from warning to critical', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = run(tracker, monitoring, [
      { at: 45 * SECOND, values: { cpuPercent: 500 } },
      { at: 60 * SECOND, values: { cpuPercent: 500 } },
      // The critical threshold needs its own 30 s before it counts.
      { at: 75 * SECOND, values: { cpuPercent: 500 } },
    ]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'escalated');
    assert.equal(events[0]?.alert.severity, 'critical');
    assert.equal(events[0]?.alert.threshold, 400);
    assert.equal(events[0]?.notify, true);
  });

  it('keeps the breach start put across escalation and de-escalation', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const breachedAt = tracker.activeFor('antivirus')[0]?.breachedAt;
    assert.equal(breachedAt, new Date(0).toISOString());

    run(tracker, monitoring, cpuSeries(45 * SECOND, 90 * SECOND, 15 * SECOND, 500));
    assert.equal(tracker.activeFor('antivirus')[0]?.severity, 'critical');
    assert.equal(tracker.activeFor('antivirus')[0]?.breachedAt, breachedAt);

    run(tracker, monitoring, [{ at: 105 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(tracker.activeFor('antivirus')[0]?.severity, 'warning');
    assert.equal(tracker.activeFor('antivirus')[0]?.breachedAt, breachedAt);
  });

  it('escalates immediately at critical when nothing was active yet', () => {
    const events = run(new AlertTracker(), config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 500));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'activated');
    assert.equal(events[0]?.alert.severity, 'critical');
  });

  it('falls back to warning when critical relieves but warning still breaches', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 500));
    const events = run(tracker, monitoring, [{ at: 45 * SECOND, values: { cpuPercent: 200 } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'deescalated');
    assert.equal(events[0]?.alert.severity, 'warning');
    // A de-escalation is not worth a desktop notification.
    assert.equal(events[0]?.notify, false);
    assert.equal(tracker.activeFor('antivirus')[0]?.severity, 'warning');
  });

  it('clears straight from critical when the value recovers fully', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 500));
    const events = run(tracker, monitoring, [{ at: 45 * SECOND, values: { cpuPercent: 5 } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'cleared');
  });

  it('requires the for-duration again after a recovery', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    run(tracker, monitoring, [{ at: 45 * SECOND, values: { cpuPercent: 5 } }]);
    const immediate = run(tracker, monitoring, [{ at: 60 * SECOND, values: { cpuPercent: 150 } }]);
    assert.deepEqual(immediate, []);
    const later = run(tracker, monitoring, [{ at: 95 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(later.length, 1);
    assert.equal(later[0]?.kind, 'activated');
  });
});

describe('cooldown', () => {
  it('suppresses the notification for a repeat breach inside the cooldown', () => {
    const tracker = new AlertTracker();
    const monitoring = config({ cooldownMs: 5 * 60 * SECOND });
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    run(tracker, monitoring, [{ at: 45 * SECOND, values: { cpuPercent: 5 } }]);

    const again = run(tracker, monitoring, cpuSeries(60 * SECOND, 90 * SECOND, 15 * SECOND, 150));
    assert.equal(again.length, 1);
    assert.equal(again[0]?.kind, 'activated');
    // Still an alert in the UI, just not another desktop banner.
    assert.equal(again[0]?.notify, false);
    assert.equal(tracker.activeFor('antivirus').length, 1);
  });

  it('notifies again once the cooldown has passed', () => {
    const tracker = new AlertTracker();
    const monitoring = config({ cooldownMs: 60 * SECOND });
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    run(tracker, monitoring, [{ at: 45 * SECOND, values: { cpuPercent: 5 } }]);
    const again = run(tracker, monitoring, cpuSeries(120 * SECOND, 150 * SECOND, 15 * SECOND, 150));
    assert.equal(again[0]?.notify, true);
  });

  it('rate-limits repeated escalations of the same alert', () => {
    const tracker = new AlertTracker();
    const monitoring = config({ cooldownMs: 5 * 60 * SECOND });
    // Warning active, then a first escalation — that one is news.
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const first = run(tracker, monitoring, cpuSeries(45 * SECOND, 90 * SECOND, 15 * SECOND, 500));
    assert.equal(first[0]?.kind, 'escalated');
    assert.equal(first[0]?.notify, true);

    // Bounce back to warning and up again: same alert, same threshold, so the
    // second crossing must not fire another desktop banner.
    run(tracker, monitoring, [{ at: 105 * SECOND, values: { cpuPercent: 150 } }]);
    const second = run(tracker, monitoring, cpuSeries(120 * SECOND, 165 * SECOND, 15 * SECOND, 500));
    assert.equal(second[0]?.kind, 'escalated');
    assert.equal(second[0]?.notify, false);
  });

  it('does not report a recovery whose breach was never reported', () => {
    const tracker = new AlertTracker();
    const monitoring = config({ cooldownMs: 10 * 60 * SECOND });
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    run(tracker, monitoring, [{ at: 45 * SECOND, values: { cpuPercent: 5 } }]);
    // Second round: activation is suppressed by the cooldown …
    const second = run(tracker, monitoring, [
      ...cpuSeries(60 * SECOND, 90 * SECOND, 15 * SECOND, 150),
      { at: 105 * SECOND, values: { cpuPercent: 5 } },
    ]);
    assert.equal(second.length, 2);
    assert.equal(second[0]?.notify, false);
    // … so its recovery stays quiet too, instead of announcing a fix for
    // something the user was never told about.
    assert.equal(second[1]?.kind, 'cleared');
    assert.equal(second[1]?.notify, false);
  });
});

describe('missing samples', () => {
  it('never alerts on a metric the provider does not report', () => {
    const monitoring = config({
      thresholds: {
        cpu: { warning: 100, forMs: 30 * SECOND, unit: 'percent' },
        netTx: { warning: 1024, forMs: 30 * SECOND, unit: 'bytesPerSecond' },
      },
    });
    const events = run(new AlertTracker(), monitoring, cpuSeries(0, 60 * SECOND, 15 * SECOND, 50));
    assert.deepEqual(events, []);
  });

  it('marks an active alert stale, then clears it when data stops arriving', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));

    // A gap shorter than staleAfterMs: the alert stays, flagged as stale.
    const stale = run(tracker, monitoring, [{ at: 45 * SECOND, values: null }]);
    assert.deepEqual(stale, []);
    assert.equal(tracker.activeFor('antivirus')[0]?.stale, true);

    const cleared = run(tracker, monitoring, [{ at: 90 * SECOND, values: null }]);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0]?.kind, 'cleared');
    assert.match(cleared[0]?.reason ?? '', /no resource samples/);
  });

  it('drops the stale flag as soon as samples resume', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    run(tracker, monitoring, [{ at: 45 * SECOND, values: null }]);
    run(tracker, monitoring, [{ at: 60 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(tracker.activeFor('antivirus')[0]?.stale, false);
  });

  it('a missing sample does not count towards the for-duration', () => {
    const events = run(new AlertTracker(), config(), [
      { at: 0, values: { cpuPercent: 150 } },
      { at: 15 * SECOND, values: null },
      { at: 30 * SECOND, values: { cpuPercent: 150 } },
    ]);
    assert.deepEqual(events, []);
  });
});

describe('actions in flight', () => {
  it('holds state while an action runs and does not stale out', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));

    // A long restart: several ticks skipped, well past staleAfterMs.
    const events = run(tracker, monitoring, [
      { at: 60 * SECOND, values: null, paused: true },
      { at: 120 * SECOND, values: null, paused: true },
      { at: 180 * SECOND, values: null, paused: true },
    ]);
    assert.deepEqual(events, []);
    assert.equal(tracker.activeFor('antivirus').length, 1);
    assert.notEqual(tracker.activeFor('antivirus')[0]?.stale, true);
  });

  it('re-requires the for-duration after the action finishes', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    const events = run(tracker, monitoring, [
      ...cpuSeries(0, 25 * SECOND, 5 * SECOND, 150),
      { at: 30 * SECOND, values: null, paused: true },
      { at: 35 * SECOND, values: { cpuPercent: 150 } },
      { at: 60 * SECOND, values: { cpuPercent: 150 } },
    ]);
    assert.deepEqual(events, []);
    assert.equal(run(tracker, monitoring, [{ at: 66 * SECOND, values: { cpuPercent: 150 } }]).length, 1);
  });
});

describe('configuration changes', () => {
  it('clears an alert whose threshold was removed', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = run(tracker, config({ thresholds: {} }), [{ at: 45 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'cleared');
    assert.equal(tracker.activeFor('antivirus').length, 0);
  });

  it('follows a threshold that a reload moved', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    assert.equal(tracker.activeFor('antivirus')[0]?.threshold, 100);

    // Threshold raised above the current value: the alert must clear against the
    // new number, and report the new number while it is still active.
    const raised = config({
      thresholds: { cpu: { warning: 500, critical: 900, forMs: 30 * SECOND, unit: 'percent' } },
    });
    const events = run(tracker, raised, [{ at: 45 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'cleared');
    assert.equal(events[0]?.alert.threshold, 500);
  });

  it('keeps showing the current threshold while an alert stays active', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const lowered = config({
      thresholds: { cpu: { warning: 120, critical: 400, forMs: 30 * SECOND, unit: 'percent' } },
    });
    run(tracker, lowered, [{ at: 45 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(tracker.activeFor('antivirus')[0]?.threshold, 120);
  });

  it('falls back to the remaining severity when the active one is removed', () => {
    const tracker = new AlertTracker();
    // Critical alert first.
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 500));
    assert.equal(tracker.activeFor('antivirus')[0]?.severity, 'critical');

    // Reload drops the critical threshold but keeps warning, which the value is
    // still over: the alert stays, at warning, against the warning threshold.
    const warningOnly = config({
      thresholds: { cpu: { warning: 100, forMs: 30 * SECOND, unit: 'percent' } },
    });
    run(tracker, warningOnly, [{ at: 45 * SECOND, values: { cpuPercent: 500 } }]);
    const alert = tracker.activeFor('antivirus')[0];
    assert.equal(alert?.severity, 'warning');
    assert.equal(alert?.threshold, 100);
  });

  it('clears an alert when monitoring is switched off for the service', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = run(tracker, config({ enabled: false }), [{ at: 45 * SECOND, values: { cpuPercent: 150 } }]);
    assert.equal(events[0]?.kind, 'cleared');
  });

  it('forgets a service that left the configuration', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 30 * SECOND, 15 * SECOND, 150));
    const events = tracker.forget('antivirus', 60 * SECOND);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'cleared');
    assert.equal(tracker.active().length, 0);
  });
});

describe('multiple metrics and services', () => {
  it('keeps state per service and metric', () => {
    const tracker = new AlertTracker();
    const monitoring = config({
      thresholds: {
        cpu: { warning: 100, forMs: 0, unit: 'percent' },
        memory: { warning: 1024, critical: 4096, forMs: 0, unit: 'bytes' },
      },
    });

    for (const at of [0, 15 * SECOND]) {
      tracker.evaluate({
        serviceId: 'a',
        serviceName: 'A',
        values: { cpuPercent: 150, memoryBytes: 8192 },
        monitoring,
        now: at,
        staleAfterMs: 45 * SECOND,
      });
      tracker.evaluate({
        serviceId: 'b',
        serviceName: 'B',
        values: { cpuPercent: 5, memoryBytes: 10 },
        monitoring,
        now: at,
        staleAfterMs: 45 * SECOND,
      });
    }

    const alerts = tracker.activeFor('a');
    assert.equal(alerts.length, 2);
    // Most severe first.
    assert.equal(alerts[0]?.severity, 'critical');
    assert.equal(alerts[0]?.metric, 'memory');
    assert.equal(tracker.activeFor('b').length, 0);
    assert.equal(tracker.active().length, 2);
  });
});

describe('pending breaches', () => {
  it('reports a crossing that has not yet lasted for the configured duration', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, cpuSeries(0, 10 * SECOND, 5 * SECOND, 150));

    const pending = tracker.pendingFor('antivirus');
    assert.equal(pending.cpu?.severity, 'warning');
    assert.equal(pending.cpu?.since, 0);
    // No alert yet: `for` is 30 s.
    assert.equal(tracker.activeFor('antivirus').length, 0);
  });

  it('reports the highest severity currently exceeded', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), [{ at: 0, values: { cpuPercent: 500 } }]);
    assert.equal(tracker.pendingFor('antivirus').cpu?.severity, 'critical');
  });

  it('forgets the crossing once the value drops back', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, [
      { at: 0, values: { cpuPercent: 150 } },
      { at: 5 * SECOND, values: { cpuPercent: 10 } },
    ]);
    assert.deepEqual(tracker.pendingFor('antivirus'), {});
  });

  it('keeps pointing at the start of the crossing, not the latest reading', () => {
    const tracker = new AlertTracker();
    run(tracker, config(), cpuSeries(0, 20 * SECOND, 5 * SECOND, 150));
    assert.equal(tracker.pendingFor('antivirus').cpu?.since, 0);
  });

  it('reports nothing for a service it has never seen', () => {
    assert.deepEqual(new AlertTracker().pendingFor('nope'), {});
  });

  it('holds its state while an action is running', () => {
    const tracker = new AlertTracker();
    const monitoring = config();
    run(tracker, monitoring, [
      { at: 0, values: { cpuPercent: 150 } },
      { at: 5 * SECOND, values: null, paused: true },
    ]);
    // A restart is not a breach: the partial crossing is dropped rather than
    // counted towards `for`.
    assert.deepEqual(tracker.pendingFor('antivirus'), {});
  });
});
