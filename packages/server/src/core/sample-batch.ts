import { parseBytes, parsePercent } from '../config/units.js';
import type { ExecRequest, ExecResult } from './exec.js';
import type { Logger } from './logger.js';
import type { ProviderSample, ProviderSampleUnit, ResourceCounters } from './resources.js';

/**
 * Per-tick shared work for providers that all talk to the same backend.
 *
 * `docker stats` costs a full daemon round trip (seconds on a busy host), and it
 * reports *every* container in one go. Running it once per Docker or Compose
 * service would spawn one process per service per tick for data that a single
 * call already contains. So the batch memoizes the call: the first provider that
 * asks starts it, everyone else awaits the same promise. One `docker stats` and
 * one `docker ps` per docker binary per tick, no matter how many services.
 *
 * A batch object is created fresh for every tick — that is also what keeps the
 * data from going stale: nothing is cached across ticks.
 *
 * The calls run without any service's environment, since one result serves many
 * services and there would be no way to choose whose environment applies. A
 * service that reaches a *different* daemon through `env: { DOCKER_HOST: … }` is
 * therefore not sampled from that daemon; its status probe, which does run with
 * the service environment, is unaffected. Batches are keyed by docker binary
 * path, so `dockerPath` variants do get their own call.
 */

export type ExecRawFn = (request: ExecRequest) => Promise<ExecResult>;

export interface DockerStatsRow {
  id: string;
  name: string;
  cpuPercent?: number;
  memoryBytes?: number;
  memoryLimitBytes?: number;
  counters: ResourceCounters;
}

export interface ComposeContainerRow {
  id: string;
  name: string;
  project: string;
  service: string;
}

/** Timeout for the batched docker calls; independent of any service timeout. */
const DOCKER_BATCH_TIMEOUT_MS = 30_000;

export class SampleBatch {
  private stats = new Map<string, Promise<Map<string, DockerStatsRow>>>();
  private compose = new Map<string, Promise<ComposeContainerRow[]>>();

  constructor(private readonly log: Logger) {}

  /**
   * All container stats, indexed by container name, full id and short id, so a
   * caller can look up whichever identifier it has.
   */
  dockerStats(dockerPath: string, exec: ExecRawFn): Promise<Map<string, DockerStatsRow>> {
    const existing = this.stats.get(dockerPath);
    if (existing) return existing;
    // Deliberately *not* caught here: a failed call is different from "no
    // containers", and the difference decides whether the dashboard drops a
    // service's numbers or keeps showing the last good ones. It is logged once
    // for the batch and then rethrown to whoever awaited it.
    const pending = this.runDockerStats(dockerPath, exec);
    this.stats.set(dockerPath, pending);
    return pending;
  }

  /** Compose project / service labels for every running container. */
  composeContainers(dockerPath: string, exec: ExecRawFn): Promise<ComposeContainerRow[]> {
    const existing = this.compose.get(dockerPath);
    if (existing) return existing;
    const pending = this.runComposePs(dockerPath, exec);
    this.compose.set(dockerPath, pending);
    return pending;
  }

  private async runDockerStats(dockerPath: string, exec: ExecRawFn): Promise<Map<string, DockerStatsRow>> {
    const result = await this.run(exec, {
      argv: [dockerPath, 'stats', '--no-stream', '--format', '{{json .}}'],
      timeoutMs: DOCKER_BATCH_TIMEOUT_MS,
      label: 'monitor:docker-stats',
    });
    return indexStats(parseDockerStats(result.stdout));
  }

  private async runComposePs(dockerPath: string, exec: ExecRawFn): Promise<ComposeContainerRow[]> {
    const result = await this.run(exec, {
      argv: [
        dockerPath,
        'ps',
        '--filter',
        'label=com.docker.compose.project',
        '--format',
        '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      timeoutMs: DOCKER_BATCH_TIMEOUT_MS,
      label: 'monitor:docker-ps',
    });
    return parseComposePs(result.stdout);
  }

  /** Runs one batched command, turning any failure into a thrown SampleError. */
  private async run(exec: ExecRawFn, request: ExecRequest): Promise<ExecResult> {
    let result: ExecResult;
    try {
      result = await exec(request);
    } catch (error) {
      this.log.warn({ err: error, label: request.label }, 'batched docker call threw');
      throw new SampleError(`${request.label} failed: ${(error as Error).message}`);
    }
    if (!result.ok) {
      const reason = result.spawnError?.message ?? `exit ${result.code}`;
      this.log.warn({ label: request.label, reason }, 'batched docker call failed');
      throw new SampleError(`${request.label} failed: ${reason}`);
    }
    return result;
  }
}

/**
 * Sampling could not be performed — as opposed to a provider reporting that
 * there is nothing to measure. The monitor keeps the previous reading for the
 * former and clears it for the latter.
 */
export class SampleError extends Error {
  override readonly name = 'SampleError';
}

/** One `docker stats` row as a provider sample unit. */
export function statsRowToUnit(row: DockerStatsRow): ProviderSampleUnit {
  const unit: ProviderSampleUnit = {};
  if (row.cpuPercent !== undefined) unit.cpuPercent = row.cpuPercent;
  if (row.memoryBytes !== undefined) unit.memoryBytes = row.memoryBytes;
  if (row.memoryLimitBytes !== undefined) unit.memoryLimitBytes = row.memoryLimitBytes;
  if (Object.keys(row.counters).length > 0) unit.counters = row.counters;
  return unit;
}

export function statsRowToSample(row: DockerStatsRow, attribution: string): ProviderSample {
  return { attribution, ...statsRowToUnit(row) };
}

interface RawStatsRow {
  ID?: string;
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  NetIO?: string;
  BlockIO?: string;
}

/** `docker stats --format '{{json .}}'` emits one JSON object per line. */
export function parseDockerStats(stdout: string): DockerStatsRow[] {
  const rows: DockerStatsRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: RawStatsRow;
    try {
      raw = JSON.parse(trimmed) as RawStatsRow;
    } catch {
      continue;
    }
    const id = raw.ID?.trim();
    const name = raw.Name?.trim();
    if (!id && !name) continue;

    const memory = splitPair(raw.MemUsage);
    const net = splitPair(raw.NetIO);
    const block = splitPair(raw.BlockIO);

    const counters: ResourceCounters = {};
    // NetIO and BlockIO are totals since the container started, so they become
    // rates only through the usual counter-delta path.
    if (net[0] !== undefined) counters.netRxBytes = net[0];
    if (net[1] !== undefined) counters.netTxBytes = net[1];
    if (block[0] !== undefined) counters.diskReadBytes = block[0];
    if (block[1] !== undefined) counters.diskWriteBytes = block[1];

    const row: DockerStatsRow = { id: id ?? name ?? '', name: name ?? id ?? '', counters };
    const cpu = optionalPercent(raw.CPUPerc);
    if (cpu !== undefined) row.cpuPercent = cpu;
    if (memory[0] !== undefined) row.memoryBytes = memory[0];
    if (memory[1] !== undefined) row.memoryLimitBytes = memory[1];
    rows.push(row);
  }
  return rows;
}

/**
 * Looks a container up by name or id. Falls back to an id prefix, because
 * `provider.container` may be the abbreviated id a `docker ps` printed.
 */
export function findStatsRow(stats: Map<string, DockerStatsRow>, container: string): DockerStatsRow | undefined {
  const exact = stats.get(container);
  if (exact) return exact;
  if (!/^[a-f0-9]{4,64}$/i.test(container)) return undefined;
  for (const row of stats.values()) {
    if (row.id.startsWith(container)) return row;
  }
  return undefined;
}

/** Indexes rows by name, full id and short id. */
export function indexStats(rows: DockerStatsRow[]): Map<string, DockerStatsRow> {
  const index = new Map<string, DockerStatsRow>();
  for (const row of rows) {
    if (row.name) index.set(row.name, row);
    if (row.id) {
      index.set(row.id, row);
      if (row.id.length > 12) index.set(row.id.slice(0, 12), row);
    }
  }
  return index;
}

export function parseComposePs(stdout: string): ComposeContainerRow[] {
  const rows: ComposeContainerRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, name, project, service] = trimmed.split('\t');
    if (!id || !project) continue;
    rows.push({ id, name: name ?? id, project, service: service ?? '' });
  }
  return rows;
}

/** `"213.6MiB / 30.27GiB"` → `[224008601, 32502023127]`. `"-- / --"` → both undefined. */
export function splitPair(value?: string): [number | undefined, number | undefined] {
  if (!value) return [undefined, undefined];
  const [left, right] = value.split('/');
  return [optionalBytes(left), optionalBytes(right)];
}

function optionalBytes(value?: string): number | undefined {
  const text = value?.trim();
  if (!text || text === '--' || text === '0') return text === '0' ? 0 : undefined;
  try {
    return parseBytes(text);
  } catch {
    return undefined;
  }
}

function optionalPercent(value?: string): number | undefined {
  const text = value?.trim();
  if (!text || text === '--') return undefined;
  try {
    return parsePercent(text);
  } catch {
    return undefined;
  }
}
