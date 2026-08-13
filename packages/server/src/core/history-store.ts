import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logger } from './logger.js';
import type { ActionRecord, HistoryEntry } from '../types.js';

/**
 * Service history log.
 *
 * The manager keeps history in memory only; a server restart used to lose it
 * entirely. This persists every entry as one JSON line so it can be replayed
 * back into memory on startup. Writing is append-only — a crash mid-write can at
 * worst drop the last line — and the file is shrunk separately by `compactHistory`
 * rather than rewritten on every append.
 */

interface HistoryLine {
  serviceId: string;
  entry: HistoryEntry;
}

/** Pre-`HistoryEntry` line shape, when history recorded actions and nothing else. */
interface LegacyHistoryLine {
  serviceId: string;
  record: ActionRecord;
}

const log = logger.child({ module: 'history-store' });

export async function appendHistory(path: string, serviceId: string, entry: HistoryEntry): Promise<void> {
  const line = `${JSON.stringify({ serviceId, entry } satisfies HistoryLine)}\n`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line, 'utf8');
  } catch (error) {
    // Losing one history line on restart is far cheaper than crashing an
    // action over a disk write failure.
    log.error({ err: error, path }, 'failed to persist history');
  }
}

export interface CompactOptions {
  /** Most entries kept per service — the same bound the in-memory list has. */
  historyLimit: number;
  /** Entries older than this are dropped. */
  retentionMs: number;
  now?: number;
}

/**
 * Reads the log, drops what retention and the per-service limit exclude, and
 * rewrites the file when anything was dropped. Returns what survived, so the
 * caller gets the load and the purge out of a single pass over the file.
 *
 * The rewrite goes through a temporary file and a rename, so an interrupted
 * compaction leaves the original log untouched rather than half of it.
 */
export async function compactHistory(
  path: string,
  options: CompactOptions,
): Promise<Map<string, HistoryEntry[]>> {
  const byService = new Map<string, HistoryEntry[]>();

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error({ err: error, path }, 'failed to read persisted history');
    }
    return byService;
  }

  const cutoff = (options.now ?? Date.now()) - options.retentionMs;
  let read = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    read += 1;
    const parsed = parseLine(line);
    if (!parsed) continue; // truncated/corrupt line: skip rather than fail startup
    if (Date.parse(parsed.entry.at) < cutoff) continue;
    const list = byService.get(parsed.serviceId) ?? [];
    list.push(parsed.entry);
    byService.set(parsed.serviceId, list);
  }

  let kept = 0;
  for (const [id, list] of byService) {
    if (list.length > options.historyLimit) {
      byService.set(id, list.slice(list.length - options.historyLimit));
    }
    kept += byService.get(id)?.length ?? 0;
  }

  if (kept < read) await rewrite(path, byService, read - kept);
  return byService;
}

function parseLine(line: string): HistoryLine | undefined {
  let parsed: Partial<HistoryLine & LegacyHistoryLine>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed?.serviceId) return undefined;
  if (parsed.entry?.at) return { serviceId: parsed.serviceId, entry: parsed.entry };
  // Written before history covered anything but actions.
  const record = parsed.record;
  if (!record?.startedAt) return undefined;
  return {
    serviceId: parsed.serviceId,
    entry: {
      kind: 'action',
      at: record.startedAt,
      severity: record.ok ? 'info' : 'error',
      label: record.label,
      message: record.message,
      action: record,
    },
  };
}

/**
 * Entries come out grouped by service instead of in their original interleaving.
 * Harmless: every reader groups by service anyway, and the order *within* a
 * service — the only one that carries meaning — is preserved.
 */
async function rewrite(path: string, byService: Map<string, HistoryEntry[]>, dropped: number): Promise<void> {
  const temporary = `${path}.tmp`;
  let body = '';
  for (const [serviceId, entries] of byService) {
    for (const entry of entries) body += `${JSON.stringify({ serviceId, entry } satisfies HistoryLine)}\n`;
  }

  try {
    await writeFile(temporary, body, 'utf8');
    await rename(temporary, path);
    log.info({ path, dropped }, 'compacted history log');
  } catch (error) {
    // The original is still intact, so the next compaction can try again.
    log.error({ err: error, path }, 'failed to compact history log');
    await unlink(temporary).catch(() => undefined);
  }
}
