import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { logger } from './logger.js';
import type { CommandOutput } from '../types.js';

/**
 * The one and only place Switchyard starts a subprocess.
 *
 * Hard rules enforced here:
 *   - `shell: false`, always. The argv array is passed straight to execve, so
 *     nothing is ever interpreted by a shell.
 *   - argv always originates from trusted configuration or provider code. This
 *     module has no notion of "user input" on purpose; callers must never build
 *     argv from HTTP parameters.
 *   - every call has a timeout and a captured-output cap.
 */

/** Max bytes captured per stream. Beyond this output is dropped and flagged. */
const MAX_CAPTURE_BYTES = 512 * 1024;

/** Grace period between SIGTERM and SIGKILL when a command times out. */
const KILL_GRACE_MS = 3_000;

export interface ExecRequest {
  argv: readonly string[];
  cwd?: string;
  /** Extra environment entries merged on top of the server environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Free-form label used for log correlation, e.g. `nginx-local:reload`. */
  label?: string;
}

export interface ExecResult {
  argv: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the binary could not be started at all (ENOENT, EACCES, ...). */
  spawnError?: { code?: string; message: string };
  /** true only when the process started, finished in time and exited 0. */
  ok: boolean;
}

export type ExecFn = (request: ExecRequest) => Promise<ExecResult>;

class Capture {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  push(chunk: Buffer): void {
    if (this.size >= MAX_CAPTURE_BYTES) {
      this.truncated = true;
      return;
    }
    const room = MAX_CAPTURE_BYTES - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = MAX_CAPTURE_BYTES;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export async function execCommand(request: ExecRequest): Promise<ExecResult> {
  const argv = [...request.argv];
  const [file, ...args] = argv;
  const timeoutMs = request.timeoutMs ?? 30_000;
  const startedAt = process.hrtime.bigint();
  const log = logger.child({ label: request.label ?? 'exec' });

  if (!file) {
    return {
      argv,
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
      spawnError: { code: 'EINVAL', message: 'empty command' },
      ok: false,
    };
  }

  log.debug({ argv, cwd: request.cwd, timeoutMs }, 'exec start');

  return await new Promise<ExecResult>((resolve) => {
    const child = spawn(file, args, {
      cwd: request.cwd,
      env: request.env ? { ...process.env, ...request.env } : process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const out = new Capture();
    const err = new Capture();
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));

    const finish = (result: Omit<ExecResult, 'durationMs' | 'ok' | 'argv' | 'truncated'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const full: ExecResult = {
        ...result,
        argv,
        durationMs,
        truncated: out.truncated || err.truncated,
        ok: !result.spawnError && !result.timedOut && result.code === 0,
      };
      log[full.ok ? 'debug' : 'warn'](
        {
          argv,
          code: full.code,
          signal: full.signal,
          durationMs,
          timedOut: full.timedOut,
          spawnError: full.spawnError?.code,
        },
        full.ok ? 'exec ok' : 'exec failed',
      );
      resolve(full);
    };

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        code: null,
        signal: null,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
        spawnError: { code: error.code, message: describeSpawnError(error, file, request.cwd) },
      });
    });

    child.on('close', (code, signal) => {
      finish({
        code,
        signal: signal ?? null,
        stdout: out.text(),
        stderr: err.text(),
        timedOut,
      });
    });
  });
}

function describeSpawnError(error: NodeJS.ErrnoException, file: string, cwd?: string): string {
  switch (error.code) {
    case 'ENOENT':
      // ENOENT is also what spawn reports when the *working directory* is gone,
      // and "command not found: docker" is a bad way to say that.
      if (cwd && !existsSync(cwd)) return `working directory does not exist: ${cwd}`;
      return `command not found: ${file}`;
    case 'EACCES':
      if (cwd && !existsSync(cwd)) return `working directory is not accessible: ${cwd}`;
      return `not executable: ${file}`;
    case 'ENOTDIR':
      return `working directory is not a directory: ${cwd ?? '?'}`;
    default:
      return error.message;
  }
}

/** Condense an ExecResult into the wire shape shown in the UI. */
export function toCommandOutput(result: ExecResult): CommandOutput {
  return {
    argv: result.argv,
    exitCode: result.code,
    stdout: trimForWire(result.stdout),
    stderr: trimForWire(result.stderr),
    durationMs: result.durationMs,
  };
}

/** Keep drawer/toast payloads small; full output stays in the server log. */
const WIRE_LIMIT = 8_000;

export function trimForWire(text: string): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= WIRE_LIMIT) return trimmed;
  return `${trimmed.slice(0, WIRE_LIMIT)}\n… truncated (${trimmed.length - WIRE_LIMIT} more characters)`;
}

/** Human-readable one-liner explaining why a command failed. */
export function failureReason(result: ExecResult): string {
  if (result.spawnError) return result.spawnError.message;
  if (result.timedOut) return `timed out after ${result.durationMs} ms`;
  const stderrLine = firstMeaningfulLine(result.stderr);
  if (stderrLine) return stderrLine;
  const stdoutLine = firstMeaningfulLine(result.stdout);
  if (stdoutLine) return stdoutLine;
  if (result.signal) return `killed by ${result.signal}`;
  return `exited with code ${result.code}`;
}

export function firstMeaningfulLine(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
  }
  return undefined;
}
