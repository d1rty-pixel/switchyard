import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from './logger.js';
import type { ActionRecord } from '../types.js';

/**
 * Action history append-only log.
 *
 * The manager keeps history in memory only; a server restart used to lose it
 * entirely. This persists every finished action as one JSON line so it can be
 * replayed back into memory on startup. Append-only by design — no rewrite,
 * no compaction — so a crash mid-write can at worst drop the last line.
 */

interface HistoryLine {
  serviceId: string;
  record: ActionRecord;
}

const log = logger.child({ module: 'history-store' });

export async function appendHistory(path: string, serviceId: string, record: ActionRecord): Promise<void> {
  const line = `${JSON.stringify({ serviceId, record } satisfies HistoryLine)}\n`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf8');
  } catch (error) {
    // Losing one history line on restart is far cheaper than crashing an
    // action over a disk write failure.
    log.error({ err: error, path }, 'failed to persist action history');
  }
}

/**
 * Reads every persisted line and groups by service, keeping at most
 * `historyLimit` most recent records per service — the same bound the
 * in-memory list is held to.
 */
export async function loadHistory(path: string, historyLimit: number): Promise<Map<string, ActionRecord[]>> {
  const byService = new Map<string, ActionRecord[]>();

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error({ err: error, path }, 'failed to read persisted action history');
    }
    return byService;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let parsed: HistoryLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // skip a truncated/corrupt line rather than fail startup
    }
    if (!parsed?.serviceId || !parsed.record) continue;
    const list = byService.get(parsed.serviceId) ?? [];
    list.push(parsed.record);
    byService.set(parsed.serviceId, list);
  }

  for (const [id, list] of byService) {
    if (list.length > historyLimit) byService.set(id, list.slice(list.length - historyLimit));
  }

  return byService;
}
