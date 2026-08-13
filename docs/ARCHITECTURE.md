# Architecture

Switchyard has three main parts:

- `packages/server` owns configuration, providers, service state, resource monitoring and the HTTP API.
- `packages/web` is a React client of that API and its SSE event stream.
- `packages/mcp` exposes the same API to MCP clients over stdio or loopback HTTP.

The YAML configuration is the source of truth. Runtime state is kept in memory, except for the bounded service activity log in `.state/history.jsonl`. There is no database or queue.

```text
browser / React SPA
    │ REST + SSE
    ▼
┌─────────────────────────────────────────────────────┐
│ Fastify API                                         │
│                                                     │
│ ServiceManager        ResourceMonitor               │
│ status + actions      samples + alerts + trends    │
│       │                       │                     │
│       └──────────┬────────────┘                     │
│                  ▼                                  │
│       command · systemd · compose · docker         │
│                  │                                  │
│              core/exec.ts                           │
└──────────────────┼──────────────────────────────────┘
                   ▼
             local processes

MCP client ── stdio / :7879 ──► packages/mcp ── HTTP ──► API
```

The web and MCP packages do not own service lifecycle state. In particular, the MCP server does not duplicate providers, monitoring, configuration parsing or the `ServiceManager`; it translates MCP tool calls into API requests.

## Technology

| Layer | Choice |
| --- | --- |
| Runtime | Node 20+, TypeScript, ESM |
| HTTP | Fastify 5 |
| Validation | zod |
| Config | YAML via js-yaml |
| Logging | pino |
| UI | React 18, Vite, Tailwind v4 |
| Client state | TanStack Query |
| Live updates | server-sent events |
| Agent access | `@modelcontextprotocol/sdk` |

The application intentionally has no database, message queue, authentication/RBAC layer or plugin registry. It is designed as a local workstation tool rather than a multi-user control plane.

## Server flow

### Status polling

`ServiceManager.refreshAll()` runs every `statusIntervalMs`, limited by `statusConcurrency`. Each provider returns a `StatusResult`; the manager stores it and emits `service:checked`. A `service:update` event is emitted when the projected summary changes.

The browser applies SSE updates to its TanStack Query cache. Periodic refetching remains as a fallback if the event stream is interrupted.

### Actions

An action request follows this path:

1. `POST /api/services/:id/actions/:action` reaches the API.
2. The service and action ids are resolved against the loaded configuration and provider capability table.
3. The manager rejects concurrent actions for the same service with `409`.
4. `provider.runAction()` executes the configured argv through `core/exec.ts`.
5. The result is recorded in service history and emitted as `action:end`.
6. After a short settle delay the service is probed again and the response includes the refreshed summary.

Command failures are action results (`ok: false`) rather than HTTP protocol errors. Unknown ids, conflicts and unsupported capabilities use 4xx responses.

### Resource sampling

Resource monitoring is independent of status polling because rate metrics require state between samples and usually need a different interval.

`ResourceMonitor.tick()`:

1. creates one `SampleBatch` for the tick;
2. skips services with actions in flight;
3. asks each provider for attributable resource counters and gauges;
4. derives rates from cumulative counters;
5. evaluates configured thresholds through `AlertTracker`;
6. stores the sample in the in-memory resource history and emits alert transitions.

Host-wide Docker data is fetched once per sampling tick and shared between Docker and Compose services through `SampleBatch`.

## Module map

```text
packages/server/src
├── index.ts              CLI, config load, bind checks, lifecycle
├── app.ts                Fastify setup, error mapping, static UI
├── types.ts              domain and API types
├── config/
│   ├── schema.ts         configuration schemas
│   ├── units.ts          duration, byte-rate and percentage parsing
│   ├── monitoring.ts     monitoring defaults and threshold resolution
│   ├── load.ts           YAML discovery and loading
│   └── diff.ts           reload preview
├── core/
│   ├── exec.ts           subprocess execution
│   ├── manager.ts        service registry, status, actions and activity
│   ├── history-store.ts  persisted activity log
│   ├── resources.ts      resource model and counter-to-rate conversion
│   ├── monitor.ts        sampling loop
│   ├── sample-batch.ts   per-tick shared backend data
│   ├── alerts.ts         alert state machine
│   ├── resource-history.ts
│   ├── resource-view.ts
│   ├── events.ts         typed event bus
│   ├── views.ts          API projections and redaction
│   ├── errors.ts
│   └── logger.ts
├── providers/
│   ├── types.ts
│   ├── index.ts
│   ├── command.ts
│   ├── systemd.ts
│   ├── compose.ts
│   └── docker.ts
└── routes/api.ts
```

```text
packages/web/src
├── main.tsx
├── App.tsx
├── index.css
├── lib/                  API client, wire types, hooks and formatting
└── components/           dashboard, cards, table, drawer, logs and dialogs
```

```text
packages/mcp/src
├── index.ts              CLI and transport selection
├── server.ts             MCP server and tool registration
├── http.ts               loopback HTTP transport
├── config.ts
├── client.ts             Switchyard HTTP client
├── format.ts
├── wire.ts
└── tools/                admin, services, resources, logs and actions
```

## Provider model

Providers translate one backend into Switchyard's common service model. A provider supplies its configuration schema, available actions, status implementation and optional logs/resource sampling.

The frontend is provider-agnostic. Providers return common fields such as `metrics`, `children`, `ports` and `warnings`; the dashboard renders those fields without checking whether the service came from systemd, Docker or something else.

`provider.actions()` is also the dispatch boundary. An API or MCP caller cannot provide an argv array; it can only select an action already declared by the provider for that service.

All subprocesses go through `context.exec` or `context.execRaw`, backed by `core/exec.ts`. This keeps timeout handling, output limits and shell-free execution in one place.

## Resource model

Providers report only resources they can attribute to the service:

- systemd uses cgroup accounting exposed by `systemctl show`;
- Docker uses container statistics;
- Compose aggregates the project's containers;
- `command` uses the pid-file process and its threads.

An unavailable metric is omitted, not reported as zero. Samples include an attribution string so the UI can state what the measurement covers.

CPU and I/O values originate as cumulative counters. The monitor keeps the previous sample for each service and derives rates from the elapsed interval. Counter state is dropped while actions run and when attribution changes.

### Alerts

`AlertTracker` is a time-based state machine. Thresholds may define a sustained `for` period, warning and critical levels, `clearBelow` hysteresis and notification cooldowns. Pending threshold state is read from the same tracker rather than recomputed elsewhere.

Alerts report transitions; they do not enforce resource limits or trigger lifecycle actions.

### Resource history

`core/resource-history.ts` keeps a bounded in-memory sample history for trend queries. Retention is limited both by `monitoring.history` and a hard cap of 2000 samples per service. Only service-level values are retained, not Compose child detail.

The API computes min, max, average, p95, latest value, sample count, threshold share and a bounded bucketed series. Resource samples are not persisted; a restart starts a new trend window.

Resource values are quantized before contributing to the service-summary fingerprint. This prevents small changes on every sample from producing an SSE update for every service while still pushing meaningful movement.

## Service activity history

Discrete events are persisted separately from resource samples. The history contains six entry kinds:

- `action` — completed actions;
- `rejected` — refused actions;
- `alert` — resource-alert transitions;
- `state` — service-state transitions;
- `probe` — status or resource-probe failure/recovery;
- `config` — service definition changes after reload.

State and probe entries are recorded on transitions only. The first successful observation after startup establishes the baseline rather than creating a synthetic state change.

`core/history-store.ts` writes JSONL to `.state/history.jsonl`. Appends are serialized so concurrent service events cannot interleave. The file is replayed at startup and compacted by age and per-service count at startup and periodically after writes. Compaction uses a temporary file and rename. Action-only history written by older versions remains compatible.

## MCP

The MCP package has two transports but one implementation of the tools.

**stdio** is intended for project-local use. The MCP client owns the process and no listener is opened. The committed `.mcp.json` uses this mode.

**HTTP** provides a long-running endpoint at `127.0.0.1:7879`, useful for user-scope registration and manageable as a Switchyard service. The listener is restricted to loopback and has no remote-bind override.

Tool responses are shaped for agent use rather than mirroring HTTP endpoints verbatim. For example, service listing is compact and resource usage can compare all services in one call. Structured content mirrors the textual answer rather than carrying information unavailable in text.

Actions marked `confirm:` require `confirm: true` in the MCP handler. This is enforced server-side rather than relying only on MCP annotations.

## Frontend

The browser uses TanStack Query for API state and patches the cache from SSE events. The server remains authoritative; the UI does not independently derive provider state or alert state.

Animations are CSS-based and disabled while the document is hidden. Overlay lifecycle is state/timer driven rather than dependent on animation completion, which avoids hidden-tab animation suspension leaving drawers or modal backdrops mounted incorrectly.

Menus that need to escape card stacking and clipping are rendered through a portal. Service state is represented by both colour and shape.

## Adding a provider

1. Create `packages/server/src/providers/<name>.ts` and implement `Provider`.
2. Define the provider `type`, zod `configSchema`, `actions()`, `status()`, `runAction()` and `supportsLogs()`; add `logs()` and `sample()` where applicable.
3. Register it in `providers/index.ts`.
4. Use `context.exec` / `context.execRaw` for subprocesses.
5. Return common status fields (`metrics`, `children`, `warnings`, `output`) instead of adding provider-specific UI logic.
6. If resource sampling is supported, report only attributable values and use the per-tick batch for host-wide backend calls.
7. Document required privileges in `docs/PRIVILEGES.md`.

No API or frontend registration is required; `/api/meta` discovers registered providers and the dashboard renders the common status model.
