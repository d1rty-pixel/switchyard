import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { appendHistory, compactHistory } from '../src/core/history-store.js';
import type { HistoryEntry } from '../src/types.js';

/**
 * The persisted history log: round trip, the pre-`HistoryEntry` line format, and
 * the purge. Nothing here goes through the manager, so the rules are asserted
 * against the file itself rather than against a replayed in-memory list.
 */

const HOUR = 3_600_000;

let dir: string;
let seq = 0;

before(async () => {
  dir = await mkdtemp(resolve(tmpdir(), 'switchyard-history-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fresh path per test, so one test's log cannot leak into another. */
function path(): string {
  seq += 1;
  return resolve(dir, `history-${seq}.jsonl`);
}

function entry(at: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    kind: 'state',
    at: new Date(at).toISOString(),
    severity: 'info',
    label: 'running → stopped',
    message: 'stopped',
    ...overrides,
  };
}

const OPTIONS = { historyLimit: 10, retentionMs: 24 * HOUR, now: 0 };

describe('history log', () => {
  it('reads back what it appended, per service and in order', async () => {
    const file = path();
    await appendHistory(file, 'a', entry(-2 * HOUR, { message: 'first' }));
    await appendHistory(file, 'b', entry(-1 * HOUR, { message: 'other service' }));
    await appendHistory(file, 'a', entry(-1 * HOUR, { message: 'second' }));

    const byService = await compactHistory(file, OPTIONS);
    assert.deepEqual(
      byService.get('a')?.map((item) => item.message),
      ['first', 'second'],
    );
    assert.equal(byService.get('b')?.length, 1);
  });

  it('returns an empty map when the log does not exist yet', async () => {
    const byService = await compactHistory(resolve(dir, 'absent.jsonl'), OPTIONS);
    assert.equal(byService.size, 0);
  });

  it('reads lines written before history covered anything but actions', async () => {
    const file = path();
    const record = {
      actionId: 'restart',
      label: 'Restart',
      ok: false,
      message: 'Restart failed',
      startedAt: new Date(-1 * HOUR).toISOString(),
      durationMs: 120,
      exitCode: 1,
    };
    await writeFile(file, `${JSON.stringify({ serviceId: 'a', record })}\n`, 'utf8');

    const restored = (await compactHistory(file, OPTIONS)).get('a')?.[0];
    assert.equal(restored?.kind, 'action');
    assert.equal(restored?.at, record.startedAt);
    assert.equal(restored?.severity, 'error'); // ok: false
    assert.equal(restored?.label, 'Restart');
    assert.deepEqual(restored?.action, record);
  });

  it('skips a truncated line instead of failing the whole load', async () => {
    const file = path();
    await appendHistory(file, 'a', entry(-1 * HOUR, { message: 'kept' }));
    await writeFile(file, '{"serviceId":"a","entry":{"kind":"stat', { flag: 'a' });

    const byService = await compactHistory(file, OPTIONS);
    assert.deepEqual(
      byService.get('a')?.map((item) => item.message),
      ['kept'],
    );
  });

  it('drops entries older than the retention window', async () => {
    const file = path();
    await appendHistory(file, 'a', entry(-48 * HOUR, { message: 'ancient' }));
    await appendHistory(file, 'a', entry(-1 * HOUR, { message: 'recent' }));

    const byService = await compactHistory(file, OPTIONS);
    assert.deepEqual(
      byService.get('a')?.map((item) => item.message),
      ['recent'],
    );
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.trim().split('\n').length, 1, 'the purge must reach the file, not only the return value');
  });

  it('keeps at most historyLimit entries per service, newest first out of the trim', async () => {
    const file = path();
    for (let index = 0; index < 5; index += 1) {
      await appendHistory(file, 'a', entry(-5 * HOUR + index * 60_000, { message: `entry-${index}` }));
    }

    const byService = await compactHistory(file, { ...OPTIONS, historyLimit: 2 });
    assert.deepEqual(
      byService.get('a')?.map((item) => item.message),
      ['entry-3', 'entry-4'],
    );
  });

  it('leaves the file alone when nothing has to be dropped', async () => {
    const file = path();
    await appendHistory(file, 'a', entry(-2 * HOUR));
    await appendHistory(file, 'b', entry(-1 * HOUR));
    const before = await readFile(file, 'utf8');

    await compactHistory(file, OPTIONS);
    assert.equal(await readFile(file, 'utf8'), before);
  });

  it('survives a log it cannot rewrite', async () => {
    const file = path();
    await appendHistory(file, 'a', entry(-48 * HOUR));
    await appendHistory(file, 'a', entry(-1 * HOUR, { message: 'recent' }));
    // A directory where the temporary file wants to be: the rename cannot happen.
    await mkdir(`${file}.tmp`, { recursive: true });

    const byService = await compactHistory(file, OPTIONS);
    assert.deepEqual(
      byService.get('a')?.map((item) => item.message),
      ['recent'],
      'the caller still gets the purged view',
    );
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.trim().split('\n').length, 2, 'the original log is intact, so the next attempt can retry');
  });
});
