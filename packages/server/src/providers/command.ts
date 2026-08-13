import { stat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { actionIdSchema, argvSchema } from '../config/schema.js';
import { failureReason, firstMeaningfulLine, toCommandOutput } from '../core/exec.js';
import type { ProviderSample, ResourceCounters } from '../core/resources.js';
import type { ActionDescriptor, ActionOutcome, LogsResult, Metric, ServiceState, StatusResult } from '../types.js';
import { splitLines, type Provider, type ProviderContext } from './types.js';

/**
 * Generic provider for services controlled by predefined local commands.
 *
 * Every command is an argv array from switchyard.yaml. There is no shell, no
 * interpolation and no way to influence the argv over the API — the API can only
 * name an action id that already exists in the configuration.
 */

const stateSchema = z.enum([
  'running',
  'stopped',
  'starting',
  'stopping',
  'degraded',
  'failed',
  'unknown',
]);

const statusProbeSchema = z.object({
  run: argvSchema,
  /**
   * `exit`   — exit code 0 means `successState`, anything else `failureState`.
   * `stdout` — trimmed stdout is looked up in `map`.
   */
  interpret: z.enum(['exit', 'stdout']).default('exit'),
  successState: stateSchema.default('running'),
  failureState: stateSchema.default('stopped'),
  map: z.record(stateSchema).default({}),
  fallbackState: stateSchema.default('unknown'),
  /** Show the first stdout line as the card summary. */
  useStdoutAsSummary: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(600_000).optional(),
});

const commandActionSchema = z.object({
  id: actionIdSchema,
  label: z.string().min(1),
  run: argvSchema,
  kind: z.enum(['primary', 'secondary', 'danger', 'utility']).default('secondary'),
  icon: z.string().optional(),
  description: z.string().optional(),
  confirm: z.boolean().default(false),
  slow: z.boolean().default(false),
  enabledIn: z.array(stateSchema).default([]),
  successMessage: z.string().optional(),
  timeoutMs: z.number().int().min(500).max(600_000).optional(),
});

const commandConfigSchema = z
  .object({
    status: statusProbeSchema.optional(),
    /** PID file used for liveness, PID and uptime metadata. */
    pidFile: z.string().optional(),
    logs: z
      .object({
        run: argvSchema,
        /** Flag used to pass the requested line count, e.g. `-n`. */
        tailArg: z.string().optional(),
        source: z.string().optional(),
        timeoutMs: z.number().int().min(500).max(600_000).optional(),
      })
      .optional(),
    actions: z.array(commandActionSchema).default([]),
  })
  .strict();

export type CommandConfig = z.infer<typeof commandConfigSchema>;
type CommandAction = z.infer<typeof commandActionSchema>;

function findAction(config: CommandConfig, id: string): CommandAction | undefined {
  return config.actions.find((action) => action.id === id);
}

export const commandProvider: Provider<CommandConfig> = {
  type: 'command',
  label: 'Command',
  description: 'Any local service driven by predefined commands from the configuration.',
  configSchema: commandConfigSchema,

  actions({ config }) {
    return config.actions.map(
      (action): ActionDescriptor => ({
        id: action.id,
        label: action.label,
        kind: action.kind,
        icon: action.icon ?? defaultIcon(action.id),
        description: action.description,
        confirm: action.confirm,
        slow: action.slow,
        enabledIn: action.enabledIn.length > 0 ? action.enabledIn : undefined,
      }),
    );
  },

  supportsLogs({ config }) {
    return config.logs !== undefined;
  },

  async status(context): Promise<StatusResult> {
    const { config } = context;
    const metrics: Metric[] = [];
    const warnings: string[] = [];
    let since: string | null = null;
    let pidAlive: boolean | undefined;

    if (config.pidFile) {
      // A relative pid file is relative to the service's working directory, not
      // to wherever the server happens to have been started from.
      const pidFilePath = isAbsolute(config.pidFile)
        ? config.pidFile
        : resolve(context.service.workdir ?? process.cwd(), config.pidFile);
      const pidInfo = await readPidFile(pidFilePath);
      if (pidInfo.error) {
        pidAlive = false;
        warnings.push(pidInfo.error);
      } else if (pidInfo.pid === undefined) {
        // Missing or truncated pid file: the service is down, and there is no
        // pid worth showing.
        pidAlive = false;
      } else {
        pidAlive = pidInfo.alive;
        metrics.push({
          label: 'PID',
          value: String(pidInfo.pid),
          kind: 'mono',
          tone: pidInfo.alive ? 'good' : 'bad',
          highlight: true,
        });
        if (!pidInfo.alive) warnings.push(`PID ${pidInfo.pid} from ${pidFilePath} is not running (stale pid file)`);
        if (pidInfo.startedAt) since = pidInfo.startedAt;
      }
    }

    if (!config.status) {
      if (pidAlive === undefined) {
        return {
          state: 'unknown',
          summary: 'No status mechanism configured',
          detail: 'Add a `provider.status` probe or a `provider.pidFile` to this service definition.',
          metrics,
          warnings: [...warnings, 'This service cannot report status.'],
        };
      }
      return {
        state: pidAlive ? 'running' : 'stopped',
        summary: pidAlive ? 'Process alive (pid file)' : 'No live process for pid file',
        since,
        metrics,
        warnings,
      };
    }

    const probe = config.status;
    const result = await context.exec({
      argv: probe.run,
      timeoutMs: probe.timeoutMs,
      label: `${context.service.id}:status`,
    });

    if (result.spawnError) {
      return {
        state: 'unknown',
        summary: result.spawnError.message,
        detail: 'The status command could not be started. Check the path and permissions.',
        metrics,
        warnings,
        errors: [result.spawnError.message],
        output: toCommandOutput(result),
      };
    }

    let state: ServiceState;
    if (probe.interpret === 'stdout') {
      const key = result.stdout.trim();
      state = probe.map[key] ?? probe.fallbackState;
    } else {
      state = result.ok ? probe.successState : probe.failureState;
    }

    if (result.timedOut) {
      state = 'unknown';
      warnings.push(`Status check timed out after ${result.durationMs} ms`);
    }

    // A pid file is authoritative for liveness. The probe then only decides
    // *how well* a live process is doing (e.g. `nginx -t` failing => degraded),
    // which is what makes "running but with a broken config" expressible.
    if (pidAlive === false && state !== 'unknown') {
      state = 'stopped';
    }

    const summary = probe.useStdoutAsSummary
      ? firstMeaningfulLine(result.stdout) ?? firstMeaningfulLine(result.stderr)
      : pidAlive === true
        ? `Process alive · pid ${metrics.find((metric) => metric.label === 'PID')?.value ?? '?'}`
        : pidAlive === false
          ? 'No live process for pid file'
          : undefined;

    const stderrLine = firstMeaningfulLine(result.stderr);
    if (stderrLine && !result.ok) warnings.push(stderrLine);

    return {
      state,
      summary,
      since,
      metrics,
      warnings,
      output: toCommandOutput(result),
    };
  },

  async runAction(context, descriptor): Promise<ActionOutcome> {
    const action = findAction(context.config, descriptor.id);
    if (!action) {
      // Unreachable: the manager resolves descriptors from `actions()`.
      return { ok: false, message: `unknown action ${descriptor.id}` };
    }

    const result = await context.exec({
      argv: action.run,
      timeoutMs: action.timeoutMs,
      label: `${context.service.id}:${action.id}`,
    });

    return {
      ok: result.ok,
      message: result.ok
        ? action.successMessage ?? `${action.label} completed`
        : `${action.label} failed: ${failureReason(result)}`,
      output: toCommandOutput(result),
    };
  },

  /**
   * Resource sampling from `/proc`, for services with a pid file.
   *
   * Scope, stated plainly because it matters for interpretation: these numbers
   * describe **the process named by the pid file, including all of its threads,
   * but none of its forked children**. A pid file names one process, and walking
   * the process tree on every tick would mean scanning all of `/proc` for a
   * number nobody asked to be approximate. The kernel's `cutime/cstime` fields
   * are no help either: they only accumulate *reaped* children, so using them
   * would make CPU jump when a worker exits rather than while it runs.
   *
   * Services whose real work happens in children are better modelled as a
   * systemd unit, where the cgroup accounts for the whole tree.
   */
  async sample(context): Promise<ProviderSample | null> {
    const { config } = context;
    if (!config.pidFile) return null;

    const pidFilePath = isAbsolute(config.pidFile)
      ? config.pidFile
      : resolve(context.service.workdir ?? process.cwd(), config.pidFile);
    const info = await readPidFile(pidFilePath);
    if (info.pid === undefined || !info.alive) return null;

    const [cpuNanos, memoryBytes, io] = await Promise.all([
      readProcCpuNanos(info.pid),
      readProcRss(info.pid),
      readProcIo(info.pid),
    ]);

    const sample: ProviderSample = {
      attribution: `pid ${info.pid} and its threads — forked child processes are not counted`,
    };
    if (memoryBytes !== undefined) sample.memoryBytes = memoryBytes;

    const counters: ResourceCounters = {};
    if (cpuNanos !== undefined) counters.cpuNanos = cpuNanos;
    if (io?.readBytes !== undefined) counters.diskReadBytes = io.readBytes;
    if (io?.writeBytes !== undefined) counters.diskWriteBytes = io.writeBytes;
    if (Object.keys(counters).length > 0) sample.counters = counters;

    // Nothing readable (a process owned by another user) is no sample at all.
    if (sample.memoryBytes === undefined && !sample.counters) return null;
    return sample;
  },

  async logs(context, options): Promise<LogsResult> {
    const logsConfig = context.config.logs;
    if (!logsConfig) return { source: 'none', lines: [] };

    const argv = logsConfig.tailArg
      ? [...logsConfig.run, logsConfig.tailArg, String(options.tail)]
      : [...logsConfig.run];

    const result = await context.exec({
      argv,
      timeoutMs: logsConfig.timeoutMs,
      label: `${context.service.id}:logs`,
    });

    const body = result.stdout.trim() ? result.stdout : result.stderr;
    const lines = splitLines(body, options.tail);

    if (result.spawnError) {
      return { source: logsConfig.source ?? argv[0] ?? 'command', lines: [`error: ${result.spawnError.message}`] };
    }

    return {
      source: logsConfig.source ?? argv.join(' '),
      lines,
      truncated: result.truncated,
    };
  },
};

interface PidFileInfo {
  pid?: number;
  alive: boolean;
  startedAt?: string;
  error?: string;
}

/**
 * Reads a pid file and derives liveness plus a start timestamp. `/proc/<pid>`
 * inode creation time is a good enough proxy for process start on Linux and
 * avoids parsing `/proc/<pid>/stat` jiffies against the boot clock.
 */
async function readPidFile(path: string): Promise<PidFileInfo> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A missing pid file is the normal state of a stopped service, not an error.
    if (code === 'ENOENT') return { alive: false };
    return { alive: false, error: `cannot read pid file ${path}: ${code ?? String(error)}` };
  }

  // Several daemons (nginx among them) truncate their pid file on shutdown, so
  // an empty file means "stopped", not "broken".
  const trimmed = raw.trim();
  if (trimmed === '') return { alive: false };

  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, error: `pid file ${path} does not contain a pid` };
  }

  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    alive = (error as NodeJS.ErrnoException).code === 'EPERM';
  }

  let startedAt: string | undefined;
  if (alive) {
    try {
      const info = await stat(`/proc/${pid}`);
      startedAt = new Date(info.ctimeMs).toISOString();
    } catch {
      startedAt = undefined;
    }
  }

  return { pid, alive, startedAt };
}

/**
 * Cumulative CPU time of a process, in nanoseconds.
 *
 * `utime + stime` from `/proc/<pid>/stat` — the same fields `top` and `ps` use,
 * and they cover **every thread** of the process. (`/proc/<pid>/schedstat` looks
 * more precise, being in nanoseconds already, but it reports the main thread
 * only, so a threaded service would be silently undercounted.)
 *
 * The fields are in clock ticks of `USER_HZ`, which is 100 on every Linux port
 * Node runs on — an ABI constant, not the configured kernel tick rate.
 */
async function readProcCpuNanos(pid: number): Promise<number | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    // The comm field may contain spaces and parentheses, so fields are counted
    // from the last ')' rather than from the start of the line.
    const tail = raw.slice(raw.lastIndexOf(')') + 2).split(/\s+/);
    // After comm and state, utime is field 14 and stime field 15 of the line.
    const utime = Number(tail[11]);
    const stime = Number(tail[12]);
    if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
    return ((utime + stime) / USER_HZ) * 1e9;
  } catch {
    return undefined;
  }
}

/** USER_HZ: the unit of the clock-tick fields in /proc, fixed at 100 on Linux. */
const USER_HZ = 100;

async function readProcRss(pid: number): Promise<number | undefined> {
  try {
    const raw = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(raw);
    if (!match?.[1]) return undefined;
    return Number(match[1]) * 1024;
  } catch {
    return undefined;
  }
}

/**
 * Bytes actually fetched from / sent to storage. Unreadable for a process owned
 * by another user, which is a normal outcome rather than an error.
 */
async function readProcIo(pid: number): Promise<{ readBytes?: number; writeBytes?: number } | undefined> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/io`, 'utf8');
  } catch {
    return undefined;
  }
  const io: { readBytes?: number; writeBytes?: number } = {};
  const read = /^read_bytes:\s+(\d+)$/m.exec(raw);
  const written = /^write_bytes:\s+(\d+)$/m.exec(raw);
  if (read?.[1]) io.readBytes = Number(read[1]);
  if (written?.[1]) io.writeBytes = Number(written[1]);
  return io.readBytes === undefined && io.writeBytes === undefined ? undefined : io;
}

function defaultIcon(actionId: string): string | undefined {
  switch (actionId) {
    case 'start':
    case 'up':
      return 'play';
    case 'stop':
    case 'down':
      return 'square';
    case 'restart':
      return 'rotate-cw';
    case 'reload':
      return 'refresh-cw';
    case 'test':
    case 'check':
      return 'shield-check';
    case 'pull':
    case 'update':
      return 'download';
    default:
      return undefined;
  }
}

export { defaultIcon };
