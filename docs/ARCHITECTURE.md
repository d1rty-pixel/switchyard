# Architecture

Switchyard is a single Node process that reads a declarative service catalogue,
probes each service through a provider adapter, and serves both a JSON API and a
static React dashboard. There is no database, no queue and no agent: state lives
in memory and the YAML files are the source of truth.

```
                          ┌──────────────────────────────────────────┐
  browser (React SPA)     │ packages/web                             │
  ── REST ──────────────► │  TanStack Query cache ◄── SSE /api/events │
                          └──────────────────────────────────────────┘
                                            │  http, 127.0.0.1:7878
                          ┌─────────────────▼────────────────────────┐
                          │ routes/api.ts    validation, SSE stream  │
                          ├──────────────────────────────────────────┤
                          │ core/manager.ts  status cache, polling,  │
                          │                  per-service lock,       │
                          │                  action history, events  │
                          ├──────────────────────────────────────────┤
                          │ core/monitor.ts  resource sampler, own   │
                          │  + alerts.ts     interval, counter state,│
                          │                  alert state machine     │
                          ├──────────────────────────────────────────┤
                          │ providers/*      command · systemd ·     │
                          │                  compose · docker        │
                          ├──────────────────────────────────────────┤
                          │ core/exec.ts     the only spawn() call   │
                          └─────────────────┬────────────────────────┘
                                            │ argv, no shell
                                      local processes
```

## Technology choices

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node 20+, TypeScript, ESM | one language for both halves, one `npm install`, no compiled toolchain |
| HTTP | Fastify 5 | small, fast, good error hooks; `@fastify/static` serves the built UI |
| Validation | zod | the config schema *is* the documentation, and the same library validates request params |
| Config | YAML (js-yaml) | comments matter in a file that describes commands |
| Logging | pino | JSON lines for piping, pretty output on a TTY |
| UI | React 18 + Vite + Tailwind v4 | fast builds, no CSS framework look, design tokens in one file |
| Server state | TanStack Query | cache + retries + background refetch, patched from SSE |
| Live updates | Server-sent events | one-directional is all this needs; reconnects for free; no WebSocket dependency |
| Animation | plain CSS keyframes | see "Animation belongs in CSS" below — no animation library at all |

Deliberately absent: database, message queue, container orchestration,
authentication, RBAC, plugin registry.

## Request and event flow

A status poll:

1. `ServiceManager.refreshAll()` runs every `statusIntervalMs` with at most
   `statusConcurrency` probes in flight.
2. Each probe calls `provider.status(context)`; the provider runs one or more
   commands through the injected `exec` and returns a `StatusResult`.
3. The manager stores the result, timestamps it, and emits
   `service:checked` always plus `service:update` when the projected summary
   changed (fingerprint comparison, so idle services generate no traffic).
4. The browser patches its query cache from those events; the 30 s `refetchInterval`
   is only a safety net for a dropped stream.

An action:

1. `POST /api/services/:id/actions/:action`.
2. The id is looked up in the service map (`404` if unknown); the action id is
   looked up in the provider's action table (`404` with the list of valid ids).
3. If the service is already busy → `409`. Otherwise it is marked busy, which the
   UI renders as a transitional state (`starting`/`stopping`) with all controls
   for that service disabled.
4. `provider.runAction()` runs the configured argv. stdout/stderr, exit code and
   duration are captured.
5. The outcome is appended to the in-memory history, `action:end` is emitted, and
   after a 500 ms settle delay the status is re-probed — signals like
   `nginx -s quit` return before the process is actually gone.
6. The response carries the outcome *and* the fresh service summary, so the card
   updates in one round trip.

A resource sampling tick (see "Resource monitoring is a second loop" below):

1. `ResourceMonitor.tick()` runs every `monitoring.interval`, never overlapping
   itself, and builds one `SampleBatch` shared by all providers in that tick.
2. Services with an action in flight are skipped and their counter state is
   dropped — a restart is not a measurement.
3. `provider.sample()` returns gauges (memory) and cumulative counters (CPU
   nanoseconds, I/O byte totals). The monitor turns counters into rates against
   the previous reading for that service.
4. `AlertTracker.evaluate()` compares the values against the resolved thresholds
   and returns state transitions — activation only after `for` has elapsed,
   clearing only below `threshold × clearBelow`.
5. Transitions are emitted as `resource:alert`; the sample lands on the service
   summary, which is pushed only when its *quantized* digest changed.

Failed commands return `{ ok: false, message, output }` with HTTP status 200.
Only protocol-level problems (unknown service, unknown action, conflict,
unsupported capability) use 4xx.

## Modules

```
packages/server/src
├── index.ts              CLI, config load, loopback guard, lifecycle
├── app.ts                Fastify app, error mapping, static UI, SPA fallback
├── types.ts              domain types shared by providers and the API
├── config/
│   ├── schema.ts         zod schemas for switchyard.yaml and services.d/*
│   ├── units.ts          strict parsers for 30s / 2GiB / 50MiB/s / 150%
│   ├── monitoring.ts     monitoring schema + global→service threshold merge
│   ├── load.ts           discovery, YAML parsing, per-service files, merge
│   └── diff.ts           reload preview: service-set diff without applying it
├── core/
│   ├── exec.ts           the single spawn() choke point
│   ├── manager.ts        registry, status cache, polling, locking, history
│   ├── history-store.ts  append-only action history log, replayed on boot
│   ├── resources.ts      resource model, counter→rate maths, sample digest
│   ├── monitor.ts        the sampling loop and its per-service counter state
│   ├── sample-batch.ts   per-tick batched docker stats / docker ps
│   ├── alerts.ts         alert state machine (for / hysteresis / cooldown)
│   ├── events.ts         typed event bus behind the SSE endpoint
│   ├── views.ts          wire projections + secret redaction
│   ├── errors.ts         SwitchyardError → HTTP status + code
│   └── logger.ts         pino instance
├── providers/
│   ├── types.ts          the Provider interface and ProviderContext
│   ├── index.ts          registry (add a provider here)
│   ├── command.ts        predefined commands, pid files
│   ├── systemd.ts        systemctl show/verbs, journalctl
│   ├── compose.ts        docker compose ps/up/down/pull/logs
│   └── docker.ts         single container inspect/start/stop/pull/logs
└── routes/api.ts         endpoints + event stream

packages/server/test      node:test suites, run with `npm test` (tsx loader)
```

```
packages/web/src
├── main.tsx              QueryClient + ToastProvider
├── App.tsx               layout, filtering, sorting, action dispatch
├── index.css             design tokens, backdrop, glass/card primitives
├── lib/                  api client, wire types, hooks, formatting, status map
└── components/           TopBar, FilterBar, ServiceCard, ServiceTable, ServiceDrawer,
                          LogPane, ActionControls, ConfirmDialog, Toasts, Logo
```

## Design decisions worth knowing

**Providers own their vocabulary.** The dashboard renders whatever `metrics`,
`children`, `ports` and `warnings` a provider returns; it has no compose- or
systemd-specific code. Adding a provider therefore needs no frontend change.

**Capability tables double as authorisation.** `provider.actions()` is the only
source of dispatchable actions: every request is checked against it, so the
table doubles as the access-control list.

**Resource monitoring is a second loop, not part of the status poll.** CPU and
I/O rates are differences between two readings, so sampling needs to remember the
previous one. `provider.status()` is stateless and runs from several places — the
boot sweep, a manual refresh, after every action — which would make the time
delta between two readings arbitrary. The two loops also want different
frequencies: status wants to be quick, sampling wants `docker stats` (a full
daemon round trip, seconds on a busy host) to run rarely. The sampler therefore
has its own interval, its own counter state and its own concurrency, and skips
any service with an action in flight.

**One backend call per tick, not per service.** `docker stats` reports every
container on the host, so running it once per Docker or Compose service would
spawn N processes for data one call already contains. `core/sample-batch.ts`
memoizes it per tick — the first provider to ask starts the call, the rest await
the same promise. It is rebuilt every tick, which is also what stops it from
serving stale numbers.

**Absent means not measurable, never zero.** systemd has no per-unit network
accounting and reports disk I/O only when the unit sets `IOAccounting=yes`; the
`command` provider sees one PID, not a process tree. Those metrics stay *missing*
rather than being reported as 0, and every sample carries an `attribution` string
the UI shows, so nobody has to guess whether a number covers child processes.
Switchyard never edits unit files to enable accounting, and never limits or kills
anything — containment is a separate concern from detection.

**Alerts are time-based and hysteretic.** `for: 30s` means elapsed wall-clock
time, not a number of samples, so changing `monitoring.interval` changes how
often the machine looks and nothing else. Clearing needs the value to fall below
`threshold × clearBelow`, otherwise a value resting on the threshold flaps. The
machine in `core/alerts.ts` is pure — values, config, `now` in; transitions out —
which is why the flapping, escalation and cooldown rules are testable without
waiting in real time.

**Samples do not drive SSE traffic.** Resource values differ on every tick, so
including them verbatim in the service-summary fingerprint would push an update
per service per interval. They enter it as a quantized digest (5 % CPU, 32 MiB
memory, 1 MiB/s rates) instead: real movement is pushed, noise is not.

**Status is a live projection.** Every card is rebuilt from the last probe plus
the busy flag; only action history survives a restart, replayed from the
append-only `.state/history.jsonl` log next to the config file (see
`core/history-store.ts`).

**Animation belongs in CSS, and stops when the tab is hidden.** This is a tool
that lives on a second monitor, so it spends most of its life in a background
tab — where browsers stop advancing animation frames. An animation that is
running but not progressing pins its element to the *first* keyframe: a drawer
parked off-screen, cards frozen at `opacity: 0`, an overlay that never looks
open. Two consequences shape the frontend:

* animations are CSS keyframes only (no animation library, and nothing driven by
  `requestAnimationFrame`), and `main.tsx` marks the document with
  `data-hidden` so a single CSS rule disables them while the tab is hidden —
  every element then renders at its final state;
* overlay mount lifecycle never waits for an animation to report completion. The
  drawer and confirm dialog are driven by state plus a timer, because a modal
  that fails to unmount leaves a full-viewport backdrop swallowing every click.

**The overflow menu renders through a portal.** Inside the card it would be a
sibling of the other grid items — painted over by later cards — and could not
flip above its trigger near the bottom of the viewport.

**Status colour is never the only signal.** Each state also has a distinct shape
and motion (pulse, hollow ring, sweeping arc, triangle, cross, dashed ring).

## Adding a provider

1. Create `packages/server/src/providers/<name>.ts` and export a `Provider`:
   a `type` string, a zod `configSchema` for the `provider:` block, `actions()`,
   `status()`, `runAction()`, `supportsLogs()` and optionally `logs()` and
   `sample()`.
2. Register it in `providers/index.ts`.
3. Use only `context.exec` / `context.execRaw` for subprocesses — never
   `child_process` directly, so timeouts, output caps and logging stay uniform.
4. Return rich status: `metrics` for numbers, `children` for sub-units,
   `warnings` for things the user should notice, `output` for the raw command
   result shown in the drawer.
5. Optionally implement `sample()` for resource monitoring. Report only what the
   backend can attribute to the service, return cumulative counters as they were
   read (the monitor derives rates), set `attribution` to what the numbers cover,
   and return `null` when there is nothing to measure. Use the `batch` argument
   for anything that returns host-wide data.
6. Document the privileges it needs in `docs/PRIVILEGES.md`.

No API or UI changes are required; `/api/meta` lists providers automatically and
the dashboard renders the new fields.
