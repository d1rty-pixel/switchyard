import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config/load.js';
import { EventBus } from '../src/core/events.js';
import { ServiceManager } from '../src/core/manager.js';
import { commandProvider } from '../src/providers/command.js';
import type { ResourceAlert } from '../src/core/alerts.js';
import type { HistoryEntry } from '../src/types.js';

/**
 * What reaches a service's history, and — just as important — what does not.
 *
 * The manager is built but never started: the poll and sample loops would make
 * the assertions depend on wall-clock timing, so every tick here is driven by
 * hand through `refresh()` and `applyMonitorResult()`.
 */

let dir: string;
let manager: ServiceManager;
let historyPath: string;

/** Flipped by creating and deleting the marker file the status probe tests for. */
function marker(): string {
  return resolve(dir, 'up');
}

function config(overrides: { probeArgs?: string } = {}): string {
  return `version: 1
settings:
  historyLimit: 20
services:
  - id: probe
    name: Probe
    type: command
    group: other
    description: ${overrides.probeArgs ?? 'unchanged'}
    monitoring:
      cpu:
        warning: 50%
        critical: 90%
    provider:
      status:
        run: [/bin/sh, -c, "test -f ${marker()}"]
        interpret: exit
      actions:
        - id: start
          label: Start
          run: [/bin/true]
  - id: quiet
    name: Quiet
    type: command
    group: other
    provider:
      status:
        run: [/bin/true]
        interpret: exit
`;
}

async function build(): Promise<void> {
  await writeFile(resolve(dir, 'switchyard.yaml'), config(), 'utf8');
  manager = new ServiceManager(await loadConfig(resolve(dir, 'switchyard.yaml')), new EventBus(), historyPath);
}

function history(id = 'probe'): HistoryEntry[] {
  // `detail()` reverses for display; the raw order is what the rules are about.
  return [...manager.detail(id).history].reverse();
}

function kinds(id = 'probe'): string[] {
  return history(id).map((entry) => entry.kind);
}

function alert(overrides: Partial<ResourceAlert> = {}): ResourceAlert {
  return {
    key: 'probe:cpu',
    serviceId: 'probe',
    serviceName: 'Probe',
    metric: 'cpu',
    label: 'CPU',
    unit: 'percent',
    severity: 'warning',
    value: 62,
    threshold: 50,
    breachedAt: '2026-01-01T00:00:00.000Z',
    activatedAt: '2026-01-01T00:00:30.000Z',
    updatedAt: '2026-01-01T00:00:30.000Z',
    active: true,
    ...overrides,
  };
}

before(async () => {
  dir = await mkdtemp(resolve(tmpdir(), 'switchyard-hist-events-'));
  historyPath = resolve(dir, '.state', 'history.jsonl');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  manager?.stop();
  await rm(historyPath, { force: true });
  await writeFile(marker(), '', 'utf8');
  await build();
});

describe('service history', () => {
  it('records a state change once, not once per probe', async () => {
    await manager.refresh('probe'); // baseline: running
    assert.deepEqual(kinds(), [], 'the first probe establishes a baseline, it is not a change');

    await unlink(marker());
    await manager.refresh('probe');
    await manager.refresh('probe');

    assert.deepEqual(kinds(), ['state']);
    const entry = history()[0];
    assert.deepEqual(entry?.state, { from: 'running', to: 'stopped' });
    assert.equal(entry?.label, 'running → stopped');
  });

  it('records a probe failure and its recovery, and nothing while it persists', async () => {
    await manager.refresh('probe');

    const original = commandProvider.status;
    commandProvider.status = async () => {
      throw new Error('probe exploded');
    };
    try {
      await manager.refresh('probe');
      await manager.refresh('probe');
    } finally {
      commandProvider.status = original;
    }
    assert.deepEqual(kinds(), ['probe']);
    assert.equal(history()[0]?.severity, 'error');
    assert.match(history()[0]?.message ?? '', /probe exploded/);

    await manager.refresh('probe');
    assert.deepEqual(kinds(), ['probe', 'probe']);
    assert.equal(history()[1]?.severity, 'info');
    assert.equal(history()[1]?.label, 'Status probe recovered');
  });

  it('records every alert transition with its measurement', () => {
    manager.applyMonitorResult({
      id: 'probe',
      type: 'command',
      events: [{ kind: 'activated', alert: alert(), notify: true, reason: 'above 50% for 0s' }],
      alerts: [alert()],
    });
    manager.applyMonitorResult({
      id: 'probe',
      type: 'command',
      events: [
        {
          kind: 'cleared',
          alert: alert({ active: false, value: 12, clearedAt: '2026-01-01T00:01:00.000Z' }),
          notify: true,
          reason: 'recovered below 45%',
        },
      ],
      alerts: [],
    });

    assert.deepEqual(kinds(), ['alert', 'alert']);
    const [activated, cleared] = history();
    assert.equal(activated?.severity, 'warning');
    assert.deepEqual(activated?.alert, {
      event: 'activated',
      metric: 'cpu',
      severity: 'warning',
      value: 62,
      threshold: 50,
      unit: 'percent',
    });
    assert.equal(cleared?.severity, 'info', 'a recovery is not a warning');
    assert.equal(cleared?.alert?.event, 'cleared');
  });

  it('records a sampling failure once and its recovery once', () => {
    const failing = { id: 'probe', type: 'command', events: [], alerts: [], error: 'docker exploded' };
    manager.applyMonitorResult(failing);
    manager.applyMonitorResult(failing);
    assert.deepEqual(kinds(), ['probe']);
    assert.equal(history()[0]?.severity, 'warning');

    manager.applyMonitorResult({
      id: 'probe',
      type: 'command',
      events: [],
      alerts: [],
      sample: { at: new Date().toISOString(), attribution: 'process', cpuPercent: 1 },
    });
    assert.deepEqual(kinds(), ['probe', 'probe']);
    assert.equal(history()[1]?.label, 'Resource sampling recovered');
  });

  it('records an action that was rejected because one was already running', async () => {
    const running = manager.runAction('probe', 'start');
    await assert.rejects(() => manager.runAction('probe', 'start'), /already running/);
    await running;

    // The rejection happened while the action was still in flight, so it is the
    // older of the two entries.
    assert.deepEqual(kinds(), ['rejected', 'action']);
    assert.equal(history()[0]?.severity, 'warning');
    assert.equal(manager.summary('probe').lastAction?.actionId, 'start', 'a rejection is not the last action');
  });

  it('records an unknown action against the service it was aimed at', async () => {
    await assert.rejects(() => manager.runAction('probe', 'nope'), /unknown action/);
    assert.deepEqual(kinds(), ['rejected']);
    assert.match(history()[0]?.message ?? '', /nope/);
  });

  it('records a reload only for the services it actually changed', async () => {
    await writeFile(resolve(dir, 'switchyard.yaml'), config({ probeArgs: 'changed' }), 'utf8');
    await manager.reload(await loadConfig(resolve(dir, 'switchyard.yaml')));

    assert.deepEqual(kinds(), ['config']);
    assert.equal(history()[0]?.label, 'Definition changed');
    assert.deepEqual(kinds('quiet'), [], 'a service the reload did not touch gets no entry');
  });

  it('persists entries and replays them into a fresh manager', async () => {
    await manager.refresh('probe');
    await unlink(marker());
    await manager.refresh('probe');
    await manager.runAction('probe', 'start');
    await manager.flush();

    manager.stop();
    await build();
    await manager.start();

    assert.deepEqual(kinds().slice(0, 2), ['state', 'action']);
    assert.equal(
      manager.summary('probe').lastAction?.actionId,
      'start',
      'the newest entry is not necessarily the newest action',
    );
  });
});
