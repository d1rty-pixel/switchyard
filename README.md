<div align="center">

<img src="docs/logo.svg" alt="Switchyard" width="72" />

# Switchyard

**A control panel for the individually managed services on your Linux workstation.**

nginx instances, Compose stacks, systemd units, containers and hand-written
scripts — each with its own control mechanism, all on one screen.

</div>

---

Switchyard treats each local service as its own thing: one
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
npm run build          # builds the UI, the server and the MCP server
npm start              # http://127.0.0.1:7878
```

That is the whole setup. The dashboard comes up with Switchyard managing its own
server process, from the one tracked definition
[`services.d/00-switchyard.yaml`](services.d/00-switchyard.yaml) — no configuration
to write first, nothing to copy, no privileges needed.

Everything else you put in `services.d/` stays local: the directory is git-ignored
apart from that one file, because service definitions describe *your* machine.
Copy-ready examples for **every provider and option** live in
[`examples/services.d/`](examples/services.d/); several run as-is with no path
editing:

```bash
# an unprivileged nginx instance and a pid-file worker, both bundled
cp examples/services.d/10-nginx-local.yaml examples/services.d/11-worker-script.yaml services.d/
```

Service ids have to be unique across the directory.

Development, with hot reload on both halves:

```bash
npm run dev            # API on :7878 (tsx watch), UI on :5273 (Vite proxy)
```

Running detached (background, survives closing the terminal), stopping, and
checking status:

```bash
scripts/switchyard-manage.sh start     # prints the dashboard URL once it's up
scripts/switchyard-manage.sh status
scripts/switchyard-manage.sh stop
scripts/switchyard-manage.sh restart
scripts/switchyard-manage.sh logs -n 100
```

This detaches the server with `setsid` and tracks it via a pid file under
`.state/` — see the script's header comment for how. The shipped
`services.d/00-switchyard.yaml` drives these same actions from the dashboard
itself, which is why a fresh checkout already has a service on it.

Validate the configuration without starting anything:

```bash
node packages/server/dist/index.js --check
```

Typechecks and tests:

```bash
npm run typecheck
npm test               # node:test suites in packages/{server,mcp}/test, run via tsx
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
monitoring:                    # resource sampling defaults, see below
  interval: 15s
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
monitoring:                    # resource thresholds, see below
  cpu: { warning: 150%, critical: 400%, for: 30s }
provider: { ... }              # provider-specific, see below
```

**`enabled: false`** is the switch to reach for when you want a service out of the
way without deleting its file: the service is skipped entirely — no polling, no
listing, no API access. The dashboard shows a collapsed "N disabled services"
strip at the bottom so they stay findable.

After editing anything, press **Reload config** in the UI (or
`curl -X POST http://127.0.0.1:7878/api/reload`). No restart, no page reload.

### Argv, not command lines

Every command is an **array of arguments**. There is no shell, so nothing is
split, globbed or expanded:

```yaml
run: [nginx, -c, /home/me/proxy/nginx.conf, -s, reload]   # correct
run: 'nginx -c /home/me/proxy/nginx.conf -s reload'       # rejected
```

Paths are used exactly as written, including `~` — write absolute paths.

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
PID, boot enablement, restart count, tasks and the unit file path (memory and CPU
come from the resource sampler instead — see **Resource monitoring**). Logs
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
  acceptedExitCodes: [2]                 # exit codes that still count as a clean stop
```

Status, health, restart policy, restart count and published ports come from a
single `docker inspect`.

Some images don't trap `SIGTERM` cleanly and exit non-zero on a normal
`docker stop` (Portainer exits `2`, for example). Without `acceptedExitCodes`
that reads as `failed` forever, even though the stop was intentional and
succeeded. List the exit code(s) that image is known to use on a clean stop
and Switchyard reports `stopped` instead, with no exit-code warning.

## Resource monitoring

Some locally managed services are perfectly healthy and still ruin the machine —
an antivirus daemon rescanning everything, a dev stack whose frontend build eats
four cores. Switchyard samples what each service actually consumes and alerts when
a service stays over a threshold you set.

Sampling is on by default and needs no configuration: cards show CPU and memory,
the drawer shows disk and network too. **Thresholds are what create alerts**, and
they are always opt-in.

```yaml
# switchyard.yaml — global defaults
monitoring:
  interval: 15s        # sampling interval, independent of statusIntervalMs
  for: 30s             # default sustained duration before an alert activates
  clearBelow: 0.9      # clear only below threshold × 0.9 (anti-flapping)
  cooldown: 5m         # minimum gap between repeat notifications
  history: 30m         # how long samples are kept in memory for trend queries
  enabled: true        # false switches sampling off entirely
```

```yaml
# services.d/antivirus.yaml — per service, merged over the global block
monitoring:
  cpu:
    warning: 150%      # 100% = one fully busy core
    critical: 400%
    for: 30s           # this metric must stay over its threshold this long
  memory:
    warning: 2GiB
    critical: 4GiB
    for: 1m
  diskWrite:
    warning: 50MiB/s
```

Metrics: `cpu`, `memory`, `diskRead`, `diskWrite`, `netRx`, `netTx`. Units are
written out — `150%`, `2GiB`, `500MB`, `50MiB/s`, `30s`, `5m` — and a value
without a unit is a config error rather than a guess. A metric block replaces the
global one for that metric, so a service that sets only `warning` does not
silently inherit a `critical` from another file. `monitoring: { enabled: false }`
opts a single service out.

### What each provider can measure

| Provider | CPU | Memory | Disk | Network | Attribution |
| --- | --- | --- | --- | --- | --- |
| `systemd` | ✓ `CPUUsageNSec` | ✓ `MemoryCurrent` | only with `IOAccounting=yes` on the unit | — | the unit's cgroup: the service and every process it spawned |
| `docker` | ✓ | ✓ | ✓ | ✓ | the container's cgroup |
| `compose` | ✓ | ✓ | ✓ | ✓ | sum over the project's containers, plus per-container detail in the drawer |
| `command` | ✓ | ✓ | ✓ where `/proc/<pid>/io` is readable | — | **the process in the pid file and its threads** — forked children are not counted |

A metric a provider cannot attribute to the service is *absent*, never zero, and
every sample says what it covers. Switchyard does not modify unit files to enable
`IOAccounting`, and per-unit network accounting does not exist in systemd at all.
A service whose real work happens in forked children is better modelled as a
systemd unit, where the cgroup covers the whole tree.

Nothing here is machine-wide: these are per-service numbers, and a busy host does
not make an idle service look guilty.

### Alert lifecycle

1. The value crosses a threshold — nothing happens yet.
2. It stays over it for `for` → the alert **activates**, and (once) fires a
   desktop notification.
3. It keeps going while nothing changes → no further events, no repeat banners.
4. It reaches `critical` for `for` → **escalates**, notifying again.
5. It drops back under `critical × clearBelow` → **de-escalates** to warning
   silently, staying active while the warning threshold is still breached.
6. It drops under `threshold × clearBelow` → **clears**, with a toast.
7. Samples stop arriving (service stopped, Docker gone) → the alert is marked
   stale and cleared after three missed intervals.

Actions pause all of this: while a restart or a `compose pull` runs, the service
is not sampled and its counters are dropped, so the restart itself never looks
like a breach or a recovery. `for` and `cooldown` are elapsed wall-clock time, so
changing `interval` never changes what `for: 30s` means.

To see all of this happen without waiting for a real service to misbehave, copy
`examples/services.d/50-load-generator.yaml` into `services.d/`: it produces a set
fraction of a core, a fixed amount of memory and a steady write rate, with a
second start action that goes over the critical thresholds so the escalation path
is visible too.

Alerts appear on the card, in the table, in the drawer with their thresholds and
timings, and at `GET /api/alerts`. Switchyard **detects and reports** — it never
throttles, stops or restarts anything on its own, and never touches `CPUQuota`,
`MemoryMax` or Docker limits.

### Trends

Samples are also kept in memory for `monitoring.history` (default `30m`), which is
what makes "was that a spike or has it been like this for ten minutes?" answerable.
`GET /api/services/:id/resources/history` returns per-metric statistics — min, max,
average, p95, latest, sample count, the span actually covered — plus the share of
samples above each threshold and a bucketed series whose length is fixed no matter
how long a window is asked for.

Nothing is written to disk: action history records something a person did and is
persisted, whereas samples are a live projection of the machine, so a restart
simply starts a fresh window. Memory is bounded twice, by the retention window and
by a hard per-service cap of 2000 samples, so a short `interval` with a long
`history` cannot grow without limit. A service whose provider changes on a config
reload has its history dropped — the old series measured something else, with a
different attribution.

## Using the dashboard

* **Search** — `/` focuses the field; matches name, id, description, tags, type,
  group, state, ports and URLs (all terms must match).
* **Filter** — group pills, status chips (multi-select) and provider chips.
  Filters and the chosen view persist across reloads.
* **Sort** — group, name, status (worst first) or last action.
* **View** — *cards* or *table*. Cards show everything about a service at once
  and read well up to a few dozen services; the table puts one service per row
  with aligned columns, which is what a long list needs to stay scannable.
* **Card** — status badge, provider, live summary, uptime, CPU and memory,
  highlighted metrics, ports, primary URL, resource alerts, first warning, inline
  actions, last action, last check.
* **Table row** — the same facts as a column each: service, state, detail,
  group, uptime, load, endpoints, actions, last check. Secondary columns drop out
  on narrow viewports rather than reflowing.
* **Drawer** — click a service: full status metrics, live resource usage with its
  attribution and active alerts, container list, endpoints, raw probe output, log
  tail, action history with output, and the service definition (including which
  file it came from and the effective monitoring thresholds).
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
| `GET` | `/api/meta` | groups, providers, config path, warnings, disabled services, host facts, metric catalogue |
| `GET` | `/api/services` | all summaries, including the latest resource sample and active alerts |
| `GET` | `/api/alerts` | active resource alerts, most severe first |
| `GET` | `/api/resources` | per-service measurements with units, thresholds and threshold state (`?service=`, `?sort=cpu`, `?limit=`) |
| `GET` | `/api/services/:id/resources/history` | trend: statistics and a bucketed series (`?window=15m`, `?buckets=30`) |
| `GET` | `/api/services/:id` | detail: children, history, raw probe, definition |
| `POST` | `/api/services/:id/actions/:action` | run an action |
| `POST` | `/api/services/:id/refresh` | re-probe now |
| `GET` | `/api/services/:id/logs?tail=200` | log tail |
| `POST` | `/api/reload` | re-read config from disk |
| `GET` | `/api/events` | SSE: `snapshot`, `service:update`, `service:checked`, `action:start`, `action:end`, `resource:alert`, `config:reload` |

Errors are `{ "error": { "code", "message", "details" } }` with `404` unknown
service/action, `409` an action is already running, `422` capability not
supported, `400` malformed id. A command that fails is still `200` with
`ok: false` and its output.

## MCP interface

Switchyard ships an MCP server so an agent — Claude Code, or anything else that
speaks MCP — can read the dashboard and drive it without shell access.

```
Claude Code ──stdio or HTTP──▶ switchyard-mcp ──HTTP on 127.0.0.1──▶ Switchyard ──▶ providers
```

`packages/mcp` is a thin client of the HTTP API above. It holds no service
catalogue, no thresholds, no monitor loop and no second `ServiceManager`: the
running server stays the single source of truth.

A committed [`.mcp.json`](.mcp.json) wires it up for Claude Code, so a checkout
needs no MCP configuration written by hand:

```bash
npm install && npm run build   # builds the UI, the server and the MCP server
npm start                      # Switchyard itself, on 127.0.0.1:7878
```

Then open Claude Code in the checkout and approve the project MCP server when
asked. `SWITCHYARD_URL` overrides the endpoint (default `http://127.0.0.1:7878`);
`switchyard-mcp --url http://host:port` does the same on the command line.

### Two transports, two scopes

The same tools are reachable two ways, and which one you want depends on whether
you are working *in this checkout* or *anywhere else*:

| | **project-local → stdio** | **global → HTTP** |
| --- | --- | --- |
| Wired up by | the committed [`.mcp.json`](.mcp.json) | `npm run mcp:install` (opt-in) |
| Scope | this repository only | every project you open |
| Client entry | `node ${CLAUDE_PROJECT_DIR}/packages/mcp/dist/index.js` | `http://127.0.0.1:7879/mcp` |
| Lifetime | one client connection; Claude Code spawns it | long-running daemon |
| Listener | none | `127.0.0.1:7879`, loopback-only, no auth |
| Managed by Switchyard | no — nothing to start or stop | yes, on the dashboard |

**Project-local (stdio)** needs nothing: open Claude Code in the checkout, approve
the project server, done. No port, no daemon, nothing to clean up.

**Global (HTTP)** exists because stdio cannot be either of those things. A
user-scope client entry has to name something that resolves identically from every
project, and `${CLAUDE_PROJECT_DIR}` resolves to whichever project is open — so a
global stdio entry needs an absolute path or a linked bin. A URL needs neither. And
a process that lives for one connection has no pid, so Switchyard cannot manage it.

```bash
npm run mcp:install                                # register at user scope, HTTP
scripts/switchyard-mcp-install.sh http --dry-run   # print the commands first
npm run mcp:install stdio                          # or: npm link + the bin
```

That runs `claude mcp add --scope user`, which writes a machine-specific URL into
your `~/.claude.json` — which is why it is a script you run rather than a config
file this repository commits. **Nothing in `npm install`, `npm run build` or
`npm start` touches your client configuration**; registration belongs to the MCP
client environment, not to Switchyard's runtime.

```bash
# what the script does, if you would rather type it
claude mcp add --scope user --transport http switchyard http://127.0.0.1:7879/mcp
```

The daemon itself is a normal Switchyard service, shipped **enabled** in
[`services.d/01-switchyard-mcp.yaml`](services.d/01-switchyard-mcp.yaml): it is on
the dashboard from the first start with status, start/stop/restart, logs and its own
CPU and memory thresholds. Like every other service, Switchyard does not start it
for you.

```bash
npm run mcp:http                        # or press Start on the card
curl -s http://127.0.0.1:7879/health
scripts/switchyard-mcp-manage.sh status
```

Shipping it enabled is only defensible because the listener **cannot** be exposed:
the bind address is checked against loopback in one place in `config.ts`, and there
is deliberately no flag, environment variable or config key to relax it — no
`allowRemoteBind` equivalent. An MCP endpoint runs actions, so a reachable one would
be a remote control panel for every service on the machine with no credential in the
path. See [`docs/PRIVILEGES.md`](docs/PRIVILEGES.md).

| Tool | Purpose |
| --- | --- |
| `switchyard_server_info` | version, uptime, config path, providers, groups, warnings, monitoring settings, host CPU/RAM |
| `list_services` | compact roster: state, provider, group, alert count, runnable action ids |
| `get_service` | one service in full: status, children, endpoints, actions, history, definition source |
| `get_resource_usage` | CPU/memory/disk/network per service with units, sample age, thresholds, threshold state |
| `get_resource_history` | min/max/avg/p95/latest, share of samples over each threshold, bucketed series |
| `get_alerts` | active alerts with value, threshold, breach start and duration |
| `get_logs` | log tail, with the same `tail` and container filters the API has |
| `run_action` | run a declared action; those marked `confirm:` need `confirm: true` |
| `refresh_service` | re-probe one service now |
| `preview_config_reload` / `apply_config_reload` | diff a config change, then apply it |

The safety model is the API's, unchanged: a caller names a service id and an
action id, both looked up in tables built from the configuration. There is no
parameter anywhere in the interface that carries a command, an argument, a path or
a provider setting, and `confirm:` is enforced in the tool handler rather than left
to a client honouring an annotation. In HTTP mode the endpoint refuses to bind
anywhere but loopback, with no `allowRemoteBind`-style escape hatch — see
[`docs/PRIVILEGES.md`](docs/PRIVILEGES.md).

Questions it answers in one call: *which services are using the most CPU*, *how
much memory is antivirus using*, *has it been under sustained load or was that a
spike*, *is anything over its configured limits*, *why is this service alerting*.

Deliberately absent: live event streaming. The dashboard's SSE feed has no useful
MCP equivalent — an agent turn is driven by tool calls, not by server push — so
current state, alerts, bounded history and an explicit `refresh_service` are what
this exposes.

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
packages/mcp      MCP server over stdio, a thin client of the HTTP API
services.d        one file per service — git-ignored except the shipped
                  00-switchyard.yaml, so a fresh checkout is never empty
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
marketplace, no database. A feature earns a place here only if it works without
any of those.

## License

MIT — see [LICENSE](LICENSE).
