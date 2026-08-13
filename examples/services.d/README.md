# Example service definitions

Copy the files you need into `services.d/` (next to `switchyard.yaml`), adjust the
paths, and press **Reload config** in the UI — no restart required.

```bash
cp examples/services.d/10-nginx-local.yaml services.d/
$EDITOR services.d/10-nginx-local.yaml
curl -X POST http://127.0.0.1:7878/api/reload
```

`services.d/*.yaml` is git-ignored, so your real service definitions stay local.

| File | Provider | Shows |
| --- | --- | --- |
| `10-nginx-local.yaml` | `command` | pid-file liveness plus a config-test probe, resource thresholds sampled from `/proc`; runs the bundled nginx instance as-is |
| `11-worker-script.yaml` | `command` | a management script with `status`/`logs` subcommands; runs the bundled worker as-is |
| `12-dev-server.yaml` | `command` | foreground process handed to `systemd-run`, `interpret: stdout`, env vars, every base option |
| `20-systemd-system.yaml` | `systemd` | a system unit through `sudo -n`, confirmations, enable/disable, cgroup resource thresholds |
| `21-systemd-user.yaml` | `systemd` | a user unit — no sudo, no polkit |
| `30-compose-stack.yaml` | `compose` | a single compose file, the common action set, per-project resource thresholds |
| `31-compose-overlays.yaml` | `compose` | multiple files, profiles, `--env-file`, `destroy`, long timeouts |
| `32-traefik-portainer.yaml` | `compose` | a reverse-proxy edge: published host ports, primary URL, confirmations |
| `40-docker-container.yaml` | `docker` | a standalone container, every option, `enabled: false` |
| `50-load-generator.yaml` | `command` | synthetic partial CPU / memory / disk load for testing resource alerts and their escalation; runs as-is (needs python3) |

The files marked "as-is" need no path editing at all: once copied into
`services.d/`, their `workdir: ..` resolves to the repository root and every path
in them is relative to that. (Relative paths always resolve against the file that
declares them, which is why they only line up after the copy.)

Switchyard managing *itself* is no longer an example: it ships as
[`../../services.d/00-switchyard.yaml`](../../services.d/00-switchyard.yaml), the one
tracked file in that otherwise git-ignored directory, so a fresh checkout has
something on the dashboard without copying anything.

Every option accepted by the configuration is exercised somewhere in this
directory; the schema itself lives in
`packages/server/src/config/schema.ts` and the per-provider blocks in
`packages/server/src/providers/*.ts`.
