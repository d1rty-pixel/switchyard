<div align="center">

<img src="docs/logo.svg" alt="Switchyard" width="72" />

# Switchyard

**A control panel for the individually managed services on your Linux workstation.**

nginx instances, Compose stacks, systemd units, containers and hand-written
scripts — each with its own control mechanism, all on one screen.

</div>

---

Switchyard is not a Docker UI. It assumes your local services are *unalike*: one
is an nginx with a custom prefix, one is a Compose project spread over two files,
one is a Perl app under hypnotoad, one is a shell script with a pid file. Each
service declares which provider drives it and which actions exist; the dashboard
renders whatever that provider reports.

* **Declarative** — one YAML file per service in `services.d/`.
* **Safe by construction** — the browser can never send a command. It names a
  service id and an action id; both are looked up in tables built from your
  config. No shell, ever.
* **Local-only** — binds `127.0.0.1`, no authentication, no telemetry.
* **Live** — status is pushed over server-sent events, not polled by the browser.
* **Hackable** — ~4 kLOC, four providers, no database.

## Requirements

* Linux with systemd (only needed for the `systemd` provider)
* Node.js ≥ 20.11
* Optional: Docker + Compose v2 for the `compose` / `docker` providers

## Install and run

```bash
git clone git@github.com:d1rty-pixel/switchyard.git && cd switchyard
npm install
npm run build          # builds the UI and compiles the server

# pick up the two ready-to-run examples (unprivileged nginx + a worker script)
cp examples/services.d/10-nginx-local.yaml examples/services.d/11-worker-script.yaml services.d/

npm start              # http://127.0.0.1:7878
```

`services.d/` starts out empty and is git-ignored — service definitions describe
your machine, so they stay local. Copy-ready examples for **every provider and
option** live in [`examples/services.d/`](examples/services.d/); the two above run
as-is with no path editing.

Development, with hot reload on both halves:

```bash
npm run dev            # API on :7878 (tsx watch), UI on :5273 (Vite proxy)
```

Validate the configuration without starting anything:

```bash
node packages/server/dist/index.js --check
```

CLI flags: `--config <path>`, `--host <addr>`, `--port <n>`, `--check`,
`--version`, `--help`. Environment: `SWITCHYARD_CONFIG`, `SWITCHYARD_LOG_LEVEL`.

Config discovery order: `--config`, `$SWITCHYARD_CONFIG`, `./switchyard.yaml`,
`~/.config/switchyard/switchyard.yaml`, `/etc/switchyard/switchyard.yaml`.

## Configuration

Two layers:

* **`switchyard.yaml`** — global settings and group definitions.
* **`services.d/*.yaml`** — one file per service, loaded automatically (sorted by
  filename, non-recursive). Override the location with `serviceDirs:`.

```yaml
# switchyard.yaml
version: 1
settings:
  host: 127.0.0.1
  port: 7878
  statusIntervalMs: 6000       # background status poll
  commandTimeoutMs: 30000      # default per-command timeout
  logsTail: 200
  historyLimit: 25
  statusConcurrency: 4
  allowRemoteBind: false       # refuse non-loopback binds unless true
serviceDirs: [services.d]
groups:
  - { id: web, name: Web, icon: globe, order: 10 }
  - { id: containers, name: Containers, icon: container, order: 20 }
```

```yaml
# services.d/my-worker.yaml
id: my-worker                  # [a-z0-9._-], used in URLs
name: My worker
description: What this thing is
icon: cpu                      # lucide name, see packages/web/src/lib/icons.tsx
type: command                  # provider
group: development
tags: [example]
enabled: true                  # false = ignored entirely (not polled, no API)
hidden: false                  # true = still managed, just not listed
workdir: /opt/my-worker        # cwd for every command of this service
env:                           # merged into the command environment
  MY_WORKER_MODE: dev
urls:
  - { label: local, url: 'http://127.0.0.1:9000/', primary: true }
ports:
  - { port: 9000, label: http }
confirm: [stop]                # extra confirmation prompts
timeoutMs: 30000               # per-service command timeout
order: 10                      # sort weight inside the group
provider: { ... }              # provider-specific, see below
```

**`enabled: false`** is the switch to reach for when you want a service out of the
way without deleting its file: it is not polled, not listed and not reachable
through the API. The dashboard shows a collapsed "N disabled services" strip at
the bottom so they stay findable.

After editing anything, press **Reload config** in the UI (or
`curl -X POST http://127.0.0.1:7878/api/reload`). No restart, no page reload.

### Argv, not command lines

Every command is an **array of arguments**. There is no shell, so nothing is
split, globbed or expanded:

```yaml
run: [nginx, -c, /home/me/proxy/nginx.conf, -s, reload]   # correct
run: 'nginx -c /home/me/proxy/nginx.conf -s reload'       # rejected
```

`~` is not expanded either — write absolute paths.

## Providers

### `command`

Any service driven by predefined commands: scripts, custom daemons, dev servers.

```yaml
provider:
  pidFile: /run/user/1000/my-worker.pid   # optional: liveness, PID, uptime
  status:
    run: [/opt/my-worker/ctl.sh, status]
    interpret: exit          # exit: code 0 → successState; stdout: look up `map`
    successState: running
    failureState: stopped
    map: { active: running, inactive: stopped }   # for interpret: stdout
    fallbackState: unknown
    useStdoutAsSummary: true # show the first stdout line on the card
  logs:
    run: [tail, /var/log/my-worker.log]
    tailArg: -n              # appended as `-n <count>`
    source: my-worker.log
  actions:
    - id: start              # id, label and argv are all yours
      label: Start
      kind: primary          # primary | secondary | danger | utility
      icon: play
      run: [/opt/my-worker/ctl.sh, start]
      enabledIn: [stopped, failed, unknown]
      confirm: false
      slow: false
      successMessage: worker started
      timeoutMs: 30000
```

When both `pidFile` and `status` are set, the pid file decides running/stopped and
the probe grades the health of a live process — that is how "running, but the
config is broken" becomes expressible (`failureState: degraded`).

### `systemd`

```yaml
provider:
  unit: chrony.service       # `.service` is appended if you omit a suffix
  scope: system              # system | user
  useSudo: true              # default: true for system, false for user
  sudoPath: sudo
  actions: [start, stop, restart, reload]   # also: enable, disable
  confirm: [stop, restart]
```

Status comes from `systemctl show` (no privileges) and includes sub-state, main
PID, boot enablement, restart count, memory, tasks and the unit file path. Logs
come from `journalctl`. Mutating verbs are wrapped in `sudo -n` so a missing rule
fails immediately instead of hanging — see **Privileges** below.

### `compose`

```yaml
provider:
  file: /srv/stack/docker-compose.yml   # or files: [base.yml, override.yml]
  projectDir: /srv/stack
  projectName: stack
  actions: [up, down, restart, pull, stop, start, recreate, build, destroy]
  slowTimeoutMs: 600000                 # up/down/pull/build budget
  requireHealthchecks: false
```

Reports per container: state, health, image, exit code, published ports and exact
start time (one batched `docker inspect`), and aggregates them into
running / degraded / failed / stopped rather than a single boolean. `destroy` is
`down -v` and deletes named volumes — opt in per service.

### `docker`

For containers that are not part of a Compose project.

```yaml
provider:
  container: my-container
  image: registry.example/my-container:latest   # required for the pull action
  actions: [start, stop, restart, pause, unpause, pull]
  confirm: [stop, restart]
  stopTimeoutSec: 15
```

Status, health, restart policy, restart count and published ports come from a
single `docker inspect`.

## Using the dashboard

* **Search** — `/` focuses the field; matches name, id, description, tags, type,
  group, state, ports and URLs (all terms must match).
* **Filter** — group pills, status chips (multi-select) and provider chips.
  Filters and layout density persist across reloads.
* **Sort** — group, name, status (worst first) or last action.
* **Card** — status badge, provider, live summary, uptime, highlighted metrics,
  ports, primary URL, first warning, inline actions, last action, last check.
* **Drawer** — click a card: full status metrics, container list, endpoints, raw
  probe output, log tail, action history with output, and the service definition
  (including which file it came from).
* **Actions** — destructive ones ask for confirmation; while one runs, every
  control for that service is locked and the card shows a transitional state.
  Failures raise a sticky toast with the exact stdout/stderr.
* **Esc** closes overlays. The header shows whether the live event stream is
  connected.

Status is expressed by colour **and** shape: pulsing dot (running), hollow ring
(stopped), sweeping arc (starting/stopping), triangle (degraded), cross (failed),
dashed ring (unknown).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | liveness, version, service count |
| `GET` | `/api/meta` | groups, providers, config path, warnings, disabled services |
| `GET` | `/api/services` | all summaries |
| `GET` | `/api/services/:id` | detail: children, history, raw probe, definition |
| `POST` | `/api/services/:id/actions/:action` | run an action |
| `POST` | `/api/services/:id/refresh` | re-probe now |
| `GET` | `/api/services/:id/logs?tail=200` | log tail |
| `POST` | `/api/reload` | re-read config from disk |
| `GET` | `/api/events` | SSE: `snapshot`, `service:update`, `service:checked`, `action:start`, `action:end`, `config:reload` |

Errors are `{ "error": { "code", "message", "details" } }` with `404` unknown
service/action, `409` an action is already running, `422` capability not
supported, `400` malformed id. A command that fails is still `200` with
`ok: false` and its output.

## Privileges

Short version: **do not run Switchyard as root.**

| Provider | Needs |
| --- | --- |
| `command` | nothing beyond your own user |
| `systemd`, status/logs | nothing (`adm`/`systemd-journal` for the system journal) |
| `systemd`, user scope | nothing |
| `systemd`, system scope verbs | a narrow `NOPASSWD` sudoers rule per unit and verb |
| `compose`, `docker` | rootless Docker, or `docker` group membership (root-equivalent) |

Start from [`contrib/sudoers.d/switchyard.example`](contrib/sudoers.d/switchyard.example)
and read [`docs/PRIVILEGES.md`](docs/PRIVILEGES.md) for the trust model, the
hardening checklist and why the `docker` group deserves a moment's thought.

The config files are trusted input — they contain commands that get executed.
Keep them owned by the Switchyard user and not group-writable.

## Architecture

```
packages/server   Fastify API, provider adapters, one guarded spawn()
packages/web      React + Vite + Tailwind dashboard
services.d        one file per service (git-ignored, yours)
examples          runnable nginx instance and worker script
docs              ARCHITECTURE.md, PRIVILEGES.md
```

The full picture, module map and the reasoning behind the technology choices are
in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Adding a provider

1. Implement the `Provider` interface in
   `packages/server/src/providers/<name>.ts` — `type`, zod `configSchema`,
   `actions()`, `status()`, `runAction()`, `supportsLogs()`, optional `logs()`.
2. Register it in `providers/index.ts`.
3. Run subprocesses only through `context.exec` / `context.execRaw`.
4. Note the privileges it needs in `docs/PRIVILEGES.md`.

No frontend work is needed: the dashboard renders whatever metrics, children,
ports and warnings a provider returns, and `/api/meta` lists it automatically.

## Examples included

* `examples/services.d/` — one file per provider, annotated, covering every
  configuration option. Copy what you need into `services.d/`.
* `examples/nginx/` — a complete unprivileged nginx instance (own prefix, pid
  file, logs, port 8480).
* `examples/scripts/sample-worker.sh` — a pid-file-managed worker driven by a
  hand-written management script.

The last two are wired up by `10-nginx-local.yaml` and `11-worker-script.yaml` and
run immediately after copying, with no privileges and no path editing.

## Scope

A personal tool for one workstation. No Kubernetes, no queues, no RBAC, no plugin
marketplace, no database. If a feature would need any of those, it does not belong
here.

## License

MIT
