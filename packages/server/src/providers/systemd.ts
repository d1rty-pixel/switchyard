import { z } from 'zod';
import { failureReason, firstMeaningfulLine, toCommandOutput } from '../core/exec.js';
import type { ActionDescriptor, ActionOutcome, LogsResult, Metric, ServiceState, StatusResult } from '../types.js';
import { splitLines, type Provider, type ProviderContext } from './types.js';

/**
 * systemd provider.
 *
 * Status is read with `systemctl show`, which needs no privileges. Mutating
 * verbs optionally go through `sudo -n` so a missing sudo rule fails
 * immediately instead of blocking on a password prompt — see docs/PRIVILEGES.md.
 */

const VERBS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const;
type Verb = (typeof VERBS)[number];

const systemdConfigSchema = z
  .object({
    /** Unit name; `.service` is appended when no suffix is given. */
    unit: z.string().min(1),
    scope: z.enum(['system', 'user']).default('system'),
    /**
     * Wrap mutating verbs in `sudo -n`. Defaults to true for system scope,
     * false for user scope.
     */
    useSudo: z.boolean().optional(),
    sudoPath: z.string().default('sudo'),
    systemctlPath: z.string().default('systemctl'),
    journalctlPath: z.string().default('journalctl'),
    actions: z.array(z.enum(VERBS)).default(['start', 'stop', 'restart', 'reload']),
    /** Ask for confirmation before these verbs, on top of the service config. */
    confirm: z.array(z.enum(VERBS)).default([]),
  })
  .strict();

export type SystemdConfig = z.infer<typeof systemdConfigSchema>;

const SHOW_PROPERTIES = [
  'Id',
  'Description',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'ExecMainStartTimestamp',
  'ActiveEnterTimestamp',
  'NRestarts',
  'Result',
  'CanReload',
  'FragmentPath',
  'MemoryCurrent',
  'TasksCurrent',
] as const;

const VERB_META: Record<Verb, { label: string; kind: ActionDescriptor['kind']; icon: string; enabledIn?: ServiceState[] }> = {
  start: { label: 'Start', kind: 'primary', icon: 'play', enabledIn: ['stopped', 'failed', 'unknown'] },
  stop: { label: 'Stop', kind: 'danger', icon: 'square', enabledIn: ['running', 'degraded', 'starting'] },
  restart: { label: 'Restart', kind: 'secondary', icon: 'rotate-cw' },
  reload: { label: 'Reload', kind: 'secondary', icon: 'refresh-cw', enabledIn: ['running', 'degraded'] },
  enable: { label: 'Enable at boot', kind: 'utility', icon: 'toggle-right' },
  disable: { label: 'Disable at boot', kind: 'utility', icon: 'toggle-left' },
};

function unitName(config: SystemdConfig): string {
  return /\.[a-z]+$/.test(config.unit) ? config.unit : `${config.unit}.service`;
}

function scopeArgs(config: SystemdConfig): string[] {
  return config.scope === 'user' ? ['--user'] : [];
}

function usesSudo(config: SystemdConfig): boolean {
  return config.useSudo ?? config.scope === 'system';
}

/** Builds argv for a mutating systemctl call. All parts are from config. */
function controlArgv(config: SystemdConfig, verb: Verb): string[] {
  const base = [config.systemctlPath, ...scopeArgs(config), verb, unitName(config)];
  return usesSudo(config) ? [config.sudoPath, '-n', ...base] : base;
}

export const systemdProvider: Provider<SystemdConfig> = {
  type: 'systemd',
  label: 'systemd',
  description: 'A systemd unit in the system or user manager.',
  configSchema: systemdConfigSchema,

  actions({ config }) {
    return config.actions.map((verb): ActionDescriptor => {
      const meta = VERB_META[verb];
      return {
        id: verb,
        label: meta.label,
        kind: meta.kind,
        icon: meta.icon,
        enabledIn: meta.enabledIn,
        confirm: config.confirm.includes(verb) || verb === 'stop',
        description: `systemctl ${config.scope === 'user' ? '--user ' : ''}${verb} ${unitName(config)}`,
      };
    });
  },

  supportsLogs() {
    return true;
  },

  async status(context): Promise<StatusResult> {
    const { config } = context;
    const result = await context.exec({
      argv: [
        config.systemctlPath,
        ...scopeArgs(config),
        'show',
        unitName(config),
        '--no-pager',
        `--property=${SHOW_PROPERTIES.join(',')}`,
      ],
      label: `${context.service.id}:status`,
    });

    if (result.spawnError) {
      return {
        state: 'unknown',
        summary: result.spawnError.message,
        errors: [result.spawnError.message],
        output: toCommandOutput(result),
      };
    }

    const props = parseShowOutput(result.stdout);
    const loadState = props.LoadState ?? 'unknown';

    if (loadState === 'not-found') {
      return {
        state: 'unknown',
        summary: `Unit ${unitName(config)} not found`,
        detail:
          config.scope === 'user'
            ? 'No such unit in the user manager. Check `systemctl --user list-unit-files`.'
            : 'No such unit in the system manager. Check `systemctl list-unit-files`.',
        errors: [`unit not found: ${unitName(config)}`],
        output: toCommandOutput(result),
      };
    }

    const activeState = props.ActiveState ?? 'unknown';
    const subState = props.SubState ?? '';
    const state = mapActiveState(activeState, subState, props.Result);

    const metrics: Metric[] = [];
    const warnings: string[] = [];

    metrics.push({
      label: 'Unit state',
      value: subState ? `${activeState} (${subState})` : activeState,
      kind: 'mono',
      tone: state === 'running' ? 'good' : state === 'failed' ? 'bad' : 'default',
    });

    const mainPid = Number.parseInt(props.MainPID ?? '0', 10);
    if (Number.isInteger(mainPid) && mainPid > 0) {
      metrics.push({ label: 'Main PID', value: String(mainPid), kind: 'mono', highlight: true });
    }

    if (props.UnitFileState) {
      metrics.push({
        label: 'Boot',
        value: props.UnitFileState,
        tone: props.UnitFileState === 'enabled' ? 'good' : 'default',
      });
    }

    const restarts = Number.parseInt(props.NRestarts ?? '0', 10);
    if (Number.isInteger(restarts) && restarts > 0) {
      metrics.push({ label: 'Restarts', value: String(restarts), kind: 'number', tone: 'warn' });
      warnings.push(`systemd has restarted this unit ${restarts} time(s)`);
    }

    const memory = Number.parseInt(props.MemoryCurrent ?? '', 10);
    if (Number.isInteger(memory) && memory > 0) {
      metrics.push({ label: 'Memory', value: String(memory), kind: 'bytes', highlight: true });
    }

    const tasks = Number.parseInt(props.TasksCurrent ?? '', 10);
    if (Number.isInteger(tasks) && tasks > 0) {
      metrics.push({ label: 'Tasks', value: String(tasks), kind: 'number' });
    }

    if (props.FragmentPath) {
      metrics.push({ label: 'Unit file', value: props.FragmentPath, kind: 'mono' });
    }

    if (props.Result && props.Result !== 'success') {
      warnings.push(`last run result: ${props.Result}`);
    }
    if (loadState === 'error' || loadState === 'bad-setting') {
      warnings.push(`unit failed to load (LoadState=${loadState})`);
    }

    const since = parseSystemdTimestamp(props.ActiveEnterTimestamp ?? props.ExecMainStartTimestamp);

    return {
      state,
      summary: props.Description || unitName(config),
      detail: describeState(activeState, subState, props.Result),
      since,
      metrics,
      warnings,
      output: toCommandOutput(result),
      raw: props,
    };
  },

  async runAction(context, descriptor): Promise<ActionOutcome> {
    const verb = descriptor.id as Verb;
    if (!context.config.actions.includes(verb)) {
      return { ok: false, message: `action ${descriptor.id} is not enabled for this unit` };
    }

    const result = await context.exec({
      argv: controlArgv(context.config, verb),
      label: `${context.service.id}:${verb}`,
    });

    if (!result.ok) {
      const hint = sudoHint(result.stderr, context.config);
      return {
        ok: false,
        message: `${descriptor.label} failed: ${hint ?? failureReason(result)}`,
        output: toCommandOutput(result),
      };
    }

    return {
      ok: true,
      message: `${descriptor.label} completed for ${unitName(context.config)}`,
      output: toCommandOutput(result),
    };
  },

  async logs(context, options): Promise<LogsResult> {
    const { config } = context;
    const argv = [
      config.journalctlPath,
      ...(config.scope === 'user' ? ['--user'] : []),
      '-u',
      unitName(config),
      '-n',
      String(options.tail),
      '--no-pager',
      '--output=short-iso',
    ];

    const result = await context.exec({ argv, label: `${context.service.id}:logs` });

    if (result.spawnError) {
      return { source: 'journalctl', lines: [`error: ${result.spawnError.message}`] };
    }

    if (!result.ok && !result.stdout.trim()) {
      const reason = firstMeaningfulLine(result.stderr) ?? `journalctl exited with ${result.code}`;
      return {
        source: 'journalctl',
        lines: [
          `error: ${reason}`,
          'hint: reading the system journal requires membership in the "systemd-journal" or "adm" group.',
        ],
      };
    }

    return {
      source: `journalctl -u ${unitName(config)}`,
      lines: splitLines(result.stdout, options.tail),
      truncated: result.truncated,
    };
  },
};

/** `systemctl show` prints `Key=Value` lines; values may contain `=`. */
function parseShowOutput(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    props[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  return props;
}

function mapActiveState(activeState: string, subState: string, result?: string): ServiceState {
  switch (activeState) {
    case 'active':
      if (subState === 'auto-restart' || subState === 'start-pre' || subState === 'start') return 'starting';
      if (subState === 'stop' || subState === 'stop-sigterm') return 'stopping';
      return 'running';
    case 'reloading':
      return 'running';
    case 'activating':
      return 'starting';
    case 'deactivating':
      return 'stopping';
    case 'failed':
      return 'failed';
    case 'inactive':
      return result && result !== 'success' ? 'failed' : 'stopped';
    case 'maintenance':
      return 'degraded';
    default:
      return 'unknown';
  }
}

function describeState(activeState: string, subState: string, result?: string): string {
  const parts = [`ActiveState=${activeState}`];
  if (subState) parts.push(`SubState=${subState}`);
  if (result) parts.push(`Result=${result}`);
  return parts.join(' · ');
}

/**
 * `systemctl show` emits timestamps like `Sun 2026-08-10 20:15:33 CEST`. The
 * zone abbreviation is the server's own local zone, so dropping it and parsing
 * as local time is correct on the machine Switchyard runs on.
 */
function parseSystemdTimestamp(value?: string): string | null {
  if (!value || value === 'n/a' || value === '0') return null;
  const match = /^[A-Za-z]{3}\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/.exec(value.trim());
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Turn the usual sudo failure modes into actionable messages. */
function sudoHint(stderr: string, config: SystemdConfig): string | undefined {
  if (!usesSudo(config)) {
    if (/Interactive authentication required/i.test(stderr)) {
      return 'polkit requires interactive authentication — add a sudo rule or a polkit policy (see docs/PRIVILEGES.md)';
    }
    return undefined;
  }
  if (/a (password|terminal) is required/i.test(stderr) || /sudo: a password is required/i.test(stderr)) {
    return `sudo needs a password — add a NOPASSWD rule for "systemctl ${config.actions.join('|')} ${unitName(config)}" (see docs/PRIVILEGES.md)`;
  }
  if (/not allowed to execute/i.test(stderr) || /is not in the sudoers file/i.test(stderr)) {
    return `sudo denied this command — the sudoers rule does not cover it (see docs/PRIVILEGES.md)`;
  }
  return undefined;
}
