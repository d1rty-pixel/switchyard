<div align="center">

<img src="docs/logo.svg" alt="Switchyard" width="72" />

# Switchyard

**One control panel for the services running on your Linux workstation.**

nginx instances, Compose stacks, systemd units, containers and hand-written scripts — each with its own lifecycle, all on one screen.

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](packages/server/tsconfig.json)
[![Platform](https://img.shields.io/badge/platform-linux-333333?style=flat-square&logo=linux&logoColor=white)](#requirements)
[![Providers](https://img.shields.io/badge/providers-command%20%C2%B7%20systemd%20%C2%B7%20compose%20%C2%B7%20docker-6E56CF?style=flat-square)](#providers)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%2B%20HTTP-D97706?style=flat-square)](#mcp-interface)

</div>

---

Switchyard is for workstations where local services do not fit one lifecycle model. One may be an nginx instance with a custom prefix, another a Compose project spread over two files, another a Perl application under hypnotoad, and another a shell script with a pid file. Each service declares how it is controlled; Switchyard gives them one dashboard.

- **Declarative** — one YAML definition per service.
- **Provider-based** — `command`, `systemd`, `compose` and `docker` are built in.
- **Controlled execution** — callers select configured service and action ids; the API never accepts arbitrary commands. Subprocesses run without a shell.
- **Live** — status changes arrive over server-sent events.
- **Resource-aware** — CPU, memory, disk and network metrics where the provider can attribute them, with optional thresholds and alerts.
- **Agent-ready** — the same service model is available through MCP over stdio or loopback HTTP.
- **Hackable** — a small TypeScript codebase, four providers, no database and no plugin framework.

## Requirements

- Linux
- Node.js ≥ 20.11
- systemd for the `systemd` provider
- Docker + Compose v2 for the `docker` and `compose` providers

## Install and run

```bash
git clone git@github.com:d1rty-pixel/switchyard.git
cd switchyard
npm install
npm run build
npm start
```

The dashboard is available at `http://127.0.0.1:7878`.

A fresh checkout already contains definitions for Switchyard itself and its optional MCP daemon. Switchyard does not automatically start managed services; the definitions simply make them visible and controllable from the dashboard.

Machine-specific service definitions belong in `services.d/` and are ignored by git. Copy-ready examples live in `examples/services.d/`:

```bash
cp examples/services.d/10-nginx-local.yaml \
   examples/services.d/11-worker-script.yaml \
   services.d/
```

For development:

```bash
npm run dev            # API :7878, Vite UI :5273
npm run typecheck
npm test
```

For a detached server:

```bash
scripts/switchyard-manage.sh start
scripts/switchyard-manage.sh status
scripts/switchyard-manage.sh logs -n 100
scripts/switchyard-manage.sh stop
```

Validate configuration without starting the server:

```bash
node packages/server/dist/index.js --check
```

Config discovery order is `--config`, `$SWITCHYARD_CONFIG`, `./switchyard.yaml`, `~/.config/switchyard/switchyard.yaml`, then `/etc/switchyard/switchyard.yaml`.

## Configuration

Switchyard uses two layers:

- `switchyard.yaml` for global settings, monitoring defaults and groups.
- `services.d/*.yaml` for services. Files are loaded in filename order and non-recursively; `serviceDirs` can override the location.

```yaml
version: 1
settings:
  host: 127.0.0.1
  port: 7878
  statusIntervalMs: 6000
  commandTimeoutMs: 30000
  logsTail: 200
  historyLimit: 100
  historyRetention: 30d
  statusConcurrency: 4
  allowRemoteBind: false
monitoring:
  interval: 15s
  history: 30m
serviceDirs: [services.d]
groups:
  - { id: web, name: Web, icon: globe, order: 10 }
  - { id: containers, name: Containers, icon: container, order: 20 }
```

A service definition describes presentation, lifecycle and provider-specific control:

```yaml
id: my-worker
name: My worker
description: Background worker
icon: cpu
type: command
group: development
tags: [example]
enabled: true
hidden: false
workdir: /opt/my-worker
env:
  MY_WORKER_MODE: dev
urls:
  - { label: local, url: 'http://127.0.0.1:9000/', primary: true }
ports:
  - { port: 9000, label: http }
confirm: [stop]
timeoutMs: 30000
order: 10
monitoring:
  cpu: { warning: 150%, critical: 400%, for: 30s }
provider: { ... }
```

`enabled: false` removes a service from polling and API access while keeping its definition discoverable in the dashboard's disabled-services section. `hidden: true` keeps it managed but omits it from the normal listing.

Reload edited configuration from the UI or with:

```bash
curl -X POST http://127.0.0.1:7878/api/reload
```

### Commands are argv arrays

Configured commands are argument arrays, not command lines:

```yaml
run: [nginx, -c, /home/me/proxy/nginx.conf, -s, reload]   # valid
run: 'nginx -c /home/me/proxy/nginx.conf -s reload'       # rejected
```

Switchyard does no shell splitting, expansion or globbing. Paths are used literally; use absolute paths instead of `~`.

## Providers

### `command`

For scripts, custom daemons and anything else controlled by predefined commands.

```yaml
provider:
  pidFile: /run/user/1000/my-worker.pid
  status:
    run: [/opt/my-worker/ctl.sh, status]
    interpret: exit
    successState: running
    failureState: stopped
    fallbackState: unknown
    useStdoutAsSummary: true
  logs:
    run: [tail, /var/log/my-worker.log]
    tailArg: -n
    source: my-worker.log
  actions:
    - id: start
      label: Start
      kind: primary
      icon: play
      run: [/opt/my-worker/ctl.sh, start]
      enabledIn: [stopped, failed, unknown]
```

With both `pidFile` and `status`, the pid file determines whether the process exists while the status probe can distinguish a healthy process from a degraded one.

### `systemd`

```yaml
provider:
  unit: chrony.service
  scope: system
  useSudo: true
  sudoPath: sudo
  actions: [start, stop, restart, reload]
  confirm: [stop, restart]
```

Status comes from `systemctl show`, logs from `journalctl`. System-scope mutations use `sudo -n`; user units normally need no extra privileges.

### `compose`

```yaml
provider:
  file: /srv/stack/docker-compose.yml
  projectDir: /srv/stack
  projectName: stack
  actions: [up, down, restart, pull, stop, start, recreate, build, destroy]
  slowTimeoutMs: 600000
  requireHealthchecks: false
```

Compose status is aggregated from the project's containers while retaining per-container state, health, image, exit code and ports. `destroy` maps to `down -v` and must be explicitly enabled.

### `docker`

```yaml
provider:
  container: my-container
  image: registry.example/my-container:latest
  actions: [start, stop, restart, pause, unpause, pull]
  confirm: [stop, restart]
  stopTimeoutSec: 15
  acceptedExitCodes: [2]
```

`acceptedExitCodes` handles images that intentionally exit non-zero after a normal stop; listed codes are treated as a clean stopped state.

## Resource monitoring

Resource sampling is enabled by default. Thresholds are optional and are what turn measurements into alerts.

```yaml
monitoring:
  interval: 15s
  for: 30s
  clearBelow: 0.9
  cooldown: 5m
  history: 30m
  enabled: true
```

Per-service settings override the global defaults:

```yaml
monitoring:
  cpu:
    warning: 150%
    critical: 400%
    for: 30s
  memory:
    warning: 2GiB
    critical: 4GiB
    for: 1m
  diskWrite:
    warning: 50MiB/s
```

Supported metrics are `cpu`, `memory`, `diskRead`, `diskWrite`, `netRx` and `netTx`. Values require explicit units. CPU uses 100% per fully busy core.

| Provider | CPU | Memory | Disk | Network | Attribution |
| --- | --- | --- | --- | --- | --- |
| `systemd` | yes | yes | with `IOAccounting=yes` | — | unit cgroup |
| `docker` | yes | yes | yes | yes | container cgroup |
| `compose` | yes | yes | yes | yes | project containers |
| `command` | yes | yes | where `/proc/<pid>/io` is readable | — | pid-file process and its threads |

Unavailable metrics are omitted rather than reported as zero. Switchyard does not change systemd accounting settings or resource limits.

Alerts support sustained-duration thresholds, warning/critical escalation and hysteresis through `clearBelow`. Sampling pauses while an action is running so lifecycle work is not mistaken for normal load. Alerts are reported in the dashboard, API, history and MCP; Switchyard does not automatically throttle, stop or restart a service in response.

### Trends and activity history

Resource samples are retained in memory for `monitoring.history` and exposed as statistics plus a bounded bucketed series. The per-service sample ring is capped at 2000 entries and is intentionally not persisted.

Service activity is persisted separately in `.state/history.jsonl`. It records:

| Kind | Recorded event |
| --- | --- |
| `action` | completed action |
| `rejected` | refused action |
| `alert` | alert transition |
| `state` | service state transition |
| `probe` | status/resource probe failure or recovery |
| `config` | service definition changed by reload |

State and probe entries are transition-based, so a persistent failure produces one event rather than one event per poll. History is bounded by `settings.historyLimit` per service and `settings.historyRetention` by age. The log is replayed on startup and periodically compacted. Older action-only history remains readable.

## Dashboard

The dashboard supports card and table views, full-text search, group/status/provider filters, sorting and per-service drawers. The drawer contains provider status, resource usage and attribution, alerts, children/containers, endpoints, logs, activity history, raw probe output and the effective service definition.

Actions are disabled while another action for the same service is running. Actions marked for confirmation require an explicit confirmation before execution. Status uses both colour and shape so state is not conveyed by colour alone.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, version, service count |
| `GET` | `/api/meta` | groups, providers, config and host metadata |
| `GET` | `/api/services` | service summaries |
| `GET` | `/api/services/:id` | service detail and activity history |
| `GET` | `/api/alerts` | active resource alerts |
| `GET` | `/api/resources` | current resource measurements |
| `GET` | `/api/services/:id/resources/history` | resource statistics and trend series |
| `GET` | `/api/services/:id/logs?tail=200` | log tail |
| `POST` | `/api/services/:id/actions/:action` | run an action |
| `POST` | `/api/services/:id/refresh` | re-probe a service |
| `POST` | `/api/reload` | re-read configuration |
| `GET` | `/api/events` | SSE event stream |

Command failures are returned as normal action results with `ok: false`; malformed requests, unknown ids, conflicts and unsupported capabilities use 4xx responses.

## MCP interface

`packages/mcp` exposes Switchyard to MCP clients without duplicating the service manager or provider logic. It is a client of the same loopback HTTP API used by the dashboard.

Two transports are available:

| | Project-local | Global |
| --- | --- | --- |
| Transport | stdio | HTTP |
| Setup | committed `.mcp.json` | `npm run mcp:install` |
| Scope | this repository | user scope |
| Listener | none | `127.0.0.1:7879` |
| Managed by Switchyard | no | yes |

The project-local stdio setup works directly from the checkout. The global HTTP mode is useful when Switchyard should be available to MCP clients from other projects:

```bash
npm run mcp:install
npm run mcp:http
```

The HTTP MCP listener is hard-restricted to loopback and has no remote-bind override. User-scope client registration is explicit: install, build and normal Switchyard startup do not modify MCP client configuration.

Available tools cover server metadata, service listing/detail, resource usage/history, alerts, logs, actions, refresh and config reload preview/apply. `confirm:` requirements are enforced by the MCP handler as well as represented in tool metadata.

See [docs/PRIVILEGES.md](docs/PRIVILEGES.md) for the trust model and MCP implications.

## Privileges

Do not run Switchyard as root. Run it as your normal user and grant only the operations individual services require.

| Provider | Typical requirement |
| --- | --- |
| `command` | current user permissions |
| `systemd` user scope | none |
| `systemd` system scope mutations | narrow `NOPASSWD` sudo rule per unit and verb |
| `docker` / `compose` | rootless Docker or Docker daemon access |

A sudoers example is included at `contrib/sudoers.d/switchyard.example`. The full trust model and hardening guidance are in [docs/PRIVILEGES.md](docs/PRIVILEGES.md).

## Architecture

```text
packages/server   Fastify API, service manager, monitoring and providers
packages/web      React + Vite + Tailwind dashboard
packages/mcp      MCP client/server over stdio or loopback HTTP
services.d        local service definitions
examples          provider and runnable service examples
docs              architecture and privilege documentation
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component boundaries, request flows and implementation details.

## Adding a provider

1. Implement the `Provider` interface in `packages/server/src/providers/<name>.ts`.
2. Register it in `providers/index.ts`.
3. Run subprocesses only through `context.exec` / `context.execRaw`.
4. Implement `sample()` if the provider can attribute resource usage.
5. Document any required privileges in `docs/PRIVILEGES.md`.

The dashboard is provider-agnostic: new providers can expose metrics, children, ports and warnings without provider-specific frontend code.

## Examples

- `examples/services.d/` — annotated definitions for the built-in providers.
- `examples/nginx/` — an unprivileged nginx instance with its own prefix, pid file and logs.
- `examples/scripts/sample-worker.sh` — a pid-file-managed worker.
- `examples/services.d/50-load-generator.yaml` — controlled CPU, memory and disk load for testing monitoring and alerts.

## Scope

Switchyard is a personal control panel for one Linux workstation. It deliberately avoids becoming a general orchestrator: no Kubernetes, cluster management, RBAC, database or plugin marketplace.

## License

MIT — see [LICENSE](LICENSE).
