import { z } from 'zod';
import { failureReason, firstMeaningfulLine, toCommandOutput } from '../core/exec.js';
import type {
  ActionDescriptor,
  ActionOutcome,
  LogsResult,
  Metric,
  PortInfo,
  ServiceState,
  StatusResult,
} from '../types.js';
import { splitLines, type Provider, type ProviderContext } from './types.js';

/**
 * Single Docker container provider, for containers that are not part of a
 * compose project (`docker run`, containers created by another tool, ...).
 *
 * Only the container *name or id* comes from configuration; nothing is derived
 * from API input. Recreating a container is deliberately out of scope: that
 * needs the original `docker run` arguments, which belong in a compose file.
 */

const DOCKER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause', 'pull'] as const;
type DockerAction = (typeof DOCKER_ACTIONS)[number];

const dockerConfigSchema = z
  .object({
    /** Container name or id. */
    container: z.string().min(1),
    dockerPath: z.string().default('docker'),
    /**
     * Image reference used by the `pull` action. Without it, `pull` is not
     * offered — the image name must come from config, not from the daemon.
     */
    image: z.string().min(1).optional(),
    actions: z.array(z.enum(DOCKER_ACTIONS)).default(['start', 'stop', 'restart']),
    confirm: z.array(z.enum(DOCKER_ACTIONS)).default([]),
    /** Seconds Docker waits for a graceful stop before killing the container. */
    stopTimeoutSec: z.number().int().min(0).max(600).optional(),
  })
  .strict();

export type DockerConfig = z.infer<typeof dockerConfigSchema>;

const ACTION_META: Record<
  DockerAction,
  { label: string; kind: ActionDescriptor['kind']; icon: string; enabledIn?: ServiceState[]; slow?: boolean }
> = {
  start: { label: 'Start', kind: 'primary', icon: 'play', enabledIn: ['stopped', 'failed', 'unknown'] },
  stop: { label: 'Stop', kind: 'danger', icon: 'square', enabledIn: ['running', 'degraded', 'starting'] },
  restart: { label: 'Restart', kind: 'secondary', icon: 'rotate-cw' },
  pause: { label: 'Pause', kind: 'utility', icon: 'pause', enabledIn: ['running', 'degraded'] },
  unpause: { label: 'Unpause', kind: 'utility', icon: 'play', enabledIn: ['stopped'] },
  pull: { label: 'Pull image', kind: 'utility', icon: 'download', slow: true },
};

/**
 * `docker inspect` with a template that emits a small JSON document — one call
 * for state, health, ports and image instead of several.
 */
const INSPECT_TEMPLATE = [
  '{',
  '"status":"{{.State.Status}}",',
  '"exitCode":{{.State.ExitCode}},',
  '"startedAt":"{{.State.StartedAt}}",',
  '"finishedAt":"{{.State.FinishedAt}}",',
  '"restartCount":{{.RestartCount}},',
  '"health":"{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",',
  '"image":"{{.Config.Image}}",',
  '"restartPolicy":"{{.HostConfig.RestartPolicy.Name}}",',
  '"ports":{{json .NetworkSettings.Ports}}',
  '}',
].join('');

interface Inspected {
  status?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  restartCount?: number;
  health?: string;
  image?: string;
  restartPolicy?: string;
  ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
}

export const dockerProvider: Provider<DockerConfig> = {
  type: 'docker',
  label: 'Docker container',
  description: 'A single Docker container, addressed by name or id.',
  configSchema: dockerConfigSchema,

  actions({ config }) {
    return config.actions
      .filter((id) => id !== 'pull' || config.image !== undefined)
      .map((id): ActionDescriptor => {
        const meta = ACTION_META[id];
        return {
          id,
          label: meta.label,
          kind: meta.kind,
          icon: meta.icon,
          enabledIn: meta.enabledIn,
          slow: meta.slow ?? false,
          confirm: config.confirm.includes(id) || id === 'stop',
          description:
            id === 'pull'
              ? `docker pull ${config.image}`
              : `docker ${id} ${config.container}`,
        };
      });
  },

  supportsLogs() {
    return true;
  },

  async status(context): Promise<StatusResult> {
    const { config } = context;
    const result = await context.exec({
      argv: [config.dockerPath, 'inspect', config.container, '--format', INSPECT_TEMPLATE],
      label: `${context.service.id}:status`,
    });

    if (result.spawnError) {
      return {
        state: 'unknown',
        summary: result.spawnError.message,
        detail: 'Could not run the docker CLI. Is Docker installed and on PATH for the Switchyard user?',
        errors: [result.spawnError.message],
        output: toCommandOutput(result),
      };
    }

    if (!result.ok) {
      const stderr = result.stderr;
      if (/No such object/i.test(stderr)) {
        return {
          state: 'unknown',
          summary: `No container named "${config.container}"`,
          detail: 'The container does not exist. It may have been removed, or the name may be wrong.',
          errors: [`no such container: ${config.container}`],
          output: toCommandOutput(result),
        };
      }
      return {
        state: 'unknown',
        summary: failureReason(result),
        detail: dockerAccessHint(stderr),
        errors: [failureReason(result)],
        output: toCommandOutput(result),
      };
    }

    let inspected: Inspected;
    try {
      inspected = JSON.parse(result.stdout.trim()) as Inspected;
    } catch {
      return {
        state: 'unknown',
        summary: 'could not parse docker inspect output',
        errors: [firstMeaningfulLine(result.stdout) ?? 'unparseable inspect output'],
        output: toCommandOutput(result),
      };
    }

    const health = normaliseHealth(inspected.health);
    const state = mapState(inspected.status, inspected.exitCode, health);
    const warnings: string[] = [];
    const metrics: Metric[] = [];

    if (inspected.image) metrics.push({ label: 'Image', value: inspected.image, kind: 'mono', highlight: true });
    if (inspected.status) {
      metrics.push({
        label: 'Container state',
        value: health === 'none' ? inspected.status : `${inspected.status} (${health})`,
        kind: 'mono',
        tone: state === 'running' ? 'good' : state === 'failed' ? 'bad' : 'default',
      });
    }
    if (inspected.restartPolicy && inspected.restartPolicy !== 'no') {
      metrics.push({ label: 'Restart policy', value: inspected.restartPolicy });
    }
    if (inspected.restartCount && inspected.restartCount > 0) {
      metrics.push({ label: 'Restarts', value: String(inspected.restartCount), kind: 'number', tone: 'warn' });
      warnings.push(`container has restarted ${inspected.restartCount} time(s)`);
    }
    if (state !== 'running' && typeof inspected.exitCode === 'number' && inspected.exitCode !== 0) {
      metrics.push({ label: 'Exit code', value: String(inspected.exitCode), kind: 'number', tone: 'bad' });
      warnings.push(`last exit code ${inspected.exitCode}`);
    }
    if (health === 'unhealthy') warnings.push('container healthcheck reports unhealthy');

    const ports = parsePorts(inspected.ports);
    const since = state === 'running' ? normaliseTimestamp(inspected.startedAt) : null;

    return {
      state,
      summary: summarise(state, inspected.status, health),
      since,
      metrics,
      warnings,
      ports,
      output: toCommandOutput(result),
    };
  },

  async runAction(context, descriptor): Promise<ActionOutcome> {
    const { config } = context;
    const id = descriptor.id as DockerAction;
    if (!config.actions.includes(id)) {
      return { ok: false, message: `action ${descriptor.id} is not enabled for this container` };
    }

    let argv: string[];
    if (id === 'pull') {
      if (!config.image) return { ok: false, message: 'pull needs provider.image in the configuration' };
      argv = [config.dockerPath, 'pull', config.image];
    } else if (id === 'stop' && config.stopTimeoutSec !== undefined) {
      argv = [config.dockerPath, 'stop', '--timeout', String(config.stopTimeoutSec), config.container];
    } else {
      argv = [config.dockerPath, id, config.container];
    }

    const result = await context.exec({
      argv,
      timeoutMs: id === 'pull' ? Math.max(context.service.timeout, 300_000) : undefined,
      label: `${context.service.id}:${id}`,
    });

    if (!result.ok) {
      return {
        ok: false,
        message: `${descriptor.label} failed: ${dockerAccessHint(result.stderr) ?? failureReason(result)}`,
        output: toCommandOutput(result),
      };
    }

    return {
      ok: true,
      message: `${descriptor.label} completed for ${config.container}`,
      output: toCommandOutput(result),
    };
  },

  async logs(context, options): Promise<LogsResult> {
    const { config } = context;
    const result = await context.exec({
      argv: [config.dockerPath, 'logs', '--tail', String(options.tail), '--timestamps', config.container],
      label: `${context.service.id}:logs`,
    });

    if (result.spawnError) {
      return { source: 'docker logs', lines: [`error: ${result.spawnError.message}`] };
    }
    if (!result.ok && !result.stdout.trim() && !result.stderr.trim()) {
      return { source: 'docker logs', lines: [`error: ${failureReason(result)}`] };
    }

    // Containers write to both streams; docker keeps them separate, so merge.
    const merged = [...splitLines(result.stdout), ...splitLines(result.stderr)].sort(byLeadingTimestamp);
    return {
      source: `docker logs ${config.container}`,
      lines: merged.slice(-options.tail),
      truncated: result.truncated,
    };
  },
};

function mapState(status: string | undefined, exitCode: number | undefined, health: string): ServiceState {
  switch (status) {
    case 'running':
      return health === 'unhealthy' ? 'degraded' : health === 'starting' ? 'starting' : 'running';
    case 'restarting':
      return 'starting';
    case 'removing':
      return 'stopping';
    case 'paused':
    case 'created':
      return 'stopped';
    case 'dead':
      return 'failed';
    case 'exited':
      return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'stopped';
    default:
      return 'unknown';
  }
}

function normaliseHealth(health?: string): string {
  return health === 'healthy' || health === 'unhealthy' || health === 'starting' ? health : 'none';
}

function summarise(state: ServiceState, status: string | undefined, health: string): string {
  if (state === 'running') return health === 'none' ? 'container running' : `container running (${health})`;
  if (state === 'degraded') return 'container running but unhealthy';
  if (state === 'failed') return 'container exited with an error';
  if (state === 'stopped') return status === 'paused' ? 'container paused' : 'container not running';
  if (state === 'starting') return 'container starting';
  return `container state ${status ?? 'unknown'}`;
}

function parsePorts(ports: Inspected['ports']): PortInfo[] {
  if (!ports) return [];
  const parsed: PortInfo[] = [];
  for (const [spec, bindings] of Object.entries(ports)) {
    const [portPart, protocolPart] = spec.split('/');
    const port = Number.parseInt(portPart ?? '', 10);
    if (!Number.isInteger(port)) continue;
    const protocol = protocolPart === 'udp' ? 'udp' : 'tcp';
    const hostPort = bindings?.[0]?.HostPort ? Number.parseInt(bindings[0].HostPort, 10) : undefined;
    if (parsed.some((entry) => entry.port === port && entry.protocol === protocol)) continue;
    parsed.push({ port, protocol, hostPort: Number.isInteger(hostPort as number) ? hostPort : undefined });
  }
  return parsed;
}

/** Docker emits RFC3339 with nanoseconds; JS only needs milliseconds. */
function normaliseTimestamp(value?: string): string | null {
  if (!value || value.startsWith('0001-01-01')) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function byLeadingTimestamp(a: string, b: string): number {
  return a.slice(0, 30).localeCompare(b.slice(0, 30));
}

function dockerAccessHint(stderr: string): string | undefined {
  if (/permission denied while trying to connect to the Docker daemon/i.test(stderr)) {
    return 'permission denied on the Docker socket — add the Switchyard user to the "docker" group or use rootless Docker (see docs/PRIVILEGES.md)';
  }
  if (/Cannot connect to the Docker daemon/i.test(stderr)) {
    return 'the Docker daemon is not reachable — is it running, and is DOCKER_HOST correct?';
  }
  return undefined;
}
