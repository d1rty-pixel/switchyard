import { z } from 'zod';
import { globalMonitoringSchema, serviceMonitoringSchema } from './monitoring.js';
import { durationSchema } from './units.js';

/**
 * Zod schemas for `switchyard.yaml`.
 *
 * The config file is a *trusted* input: it may contain argv arrays that will be
 * executed. It is therefore treated like a systemd unit file — see
 * docs/PRIVILEGES.md. Validation here exists to catch mistakes and to give good
 * error messages, not to sandbox a hostile author.
 */

/** Service and group ids are used in URLs, so keep them boring. */
export const idSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'must be lowercase letters, digits, dot, dash or underscore (max 64)');

/** Action ids are matched against provider capabilities before dispatch. */
export const actionIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, 'must be lowercase letters, digits, dot, dash or underscore (max 32)');

/** An argv array. Never a string — Switchyard does not parse command lines. */
export const argvSchema = z
  .array(z.string().min(1, 'argv entries must not be empty'))
  .min(1, 'argv needs at least the program name');

export const portSchema = z.union([
  z.number().int().min(1).max(65535),
  z.object({
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']).default('tcp'),
    label: z.string().optional(),
    url: z.string().optional(),
  }),
]);

export const urlSchema = z.union([
  z.string().min(1),
  z.object({
    label: z.string().min(1),
    url: z.string().min(1),
    primary: z.boolean().optional(),
  }),
]);

export const groupSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  order: z.number().int().optional(),
});

export const settingsSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(7878),
    /** Background status poll interval. */
    statusIntervalMs: z.number().int().min(1_000).max(600_000).default(6_000),
    /** Default per-command timeout; services and actions may override. */
    commandTimeoutMs: z.number().int().min(500).max(600_000).default(30_000),
    /** How many log lines the logs endpoint returns by default. */
    logsTail: z.number().int().min(10).max(5_000).default(200),
    /** Per-service history entries kept in memory and replayed from disk. */
    historyLimit: z.number().int().min(1).max(500).default(100),
    /** How long a persisted history entry survives before it is purged. */
    historyRetention: durationSchema.default('30d'),
    /** How many status probes may run at once. */
    statusConcurrency: z.number().int().min(1).max(32).default(4),
    /**
     * Escape hatch for binding to a non-loopback address. Off by default: there
     * is no authentication, so a reachable Switchyard is a remote control panel
     * for everything it manages.
     */
    allowRemoteBind: z.boolean().default(false),
  })
  .default({});

/**
 * The provider block is validated in a second pass by the provider itself, so
 * that error paths can point at `services[3].provider.unit`.
 */
export const serviceBaseSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  icon: z.string().optional(),
  type: z.string().min(1),
  group: idSchema.default('other'),
  tags: z.array(z.string().min(1)).default([]),
  /** Working directory for every command of this service. */
  workdir: z.string().optional(),
  /** Extra environment variables merged on top of the server environment. */
  env: z.record(z.string()).default({}),
  urls: z.array(urlSchema).default([]),
  ports: z.array(portSchema).default([]),
  /** Action ids that require confirmation, in addition to provider defaults. */
  confirm: z.array(actionIdSchema).default([]),
  /** Per-service command timeout override. */
  timeoutMs: z.number().int().min(500).max(600_000).optional(),
  /** Sort weight inside its group; lower comes first. */
  order: z.number().int().optional(),
  /**
   * Set to false to switch a service off without deleting its definition: it is
   * not polled, not listed and not reachable through the API.
   */
  enabled: z.boolean().default(true),
  /** Keep the definition active (still polled) but hide it from the dashboard. */
  hidden: z.boolean().default(false),
  /**
   * Resource thresholds for this service, merged on top of the global
   * `monitoring:` block. Omit it to sample without ever alerting.
   */
  monitoring: serviceMonitoringSchema,
  provider: z.unknown().optional(),
});

export const configFileSchema = z.object({
  version: z.literal(1).default(1),
  settings: settingsSchema,
  /** Global resource monitoring defaults; see config/monitoring.ts. */
  monitoring: globalMonitoringSchema,
  groups: z.array(groupSchema).default([]),
  /** Inline services. Usually empty — prefer one file per service in services.d/. */
  services: z.array(serviceBaseSchema).default([]),
  /**
   * Directories scanned for per-service files (`*.yaml` / `*.yml`, non-recursive).
   * Relative paths resolve against the main config file. Defaults to
   * `services.d` next to switchyard.yaml when that directory exists.
   */
  serviceDirs: z.array(z.string().min(1)).optional(),
});

/**
 * A file inside a services directory: either a bare service definition, or a
 * `services:` list for people who prefer grouping a few related units.
 */
export const serviceFileSchema = z.union([
  z.object({ services: z.array(serviceBaseSchema).min(1) }),
  serviceBaseSchema,
]);

export type ConfigFile = z.infer<typeof configFileSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type GroupDefinition = z.infer<typeof groupSchema>;
export type ServiceBase = z.infer<typeof serviceBaseSchema>;
