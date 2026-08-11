# Privileges and trust boundaries

Switchyard is a local control panel that executes preconfigured commands. This
document states exactly what it trusts, its execution guarantees, and which
privileges each provider needs.

## Trust model in one paragraph

The configuration (`switchyard.yaml` plus `services.d/*.yaml`) is **trusted
input**: it contains argv arrays that are executed as the user running
Switchyard. Treat those files like systemd unit files. The **HTTP API is
untrusted input**: it can only name a service id and an action id, both of which
are looked up in tables built from the configuration. There is no code path from
a request body or query parameter into an argv array.

Concretely:

* every subprocess goes through `core/exec.ts`, which always uses
  `spawn(file, args, { shell: false })` — no shell, no globbing, no word
  splitting, no interpolation;
* an action must exist in the provider's `actions()` table, which is derived from
  configuration, or the request is rejected with `404`;
* service ids are validated against `^[a-z0-9][a-z0-9._-]{0,63}$` and then used
  only as map keys — path traversal has nothing to traverse;
* every command has a timeout, captured output is capped at 512 KiB, and only the
  first 8 KB of each stream is sent to the browser;
* one action at a time per service (a second one gets `409`), so two conflicting
  commands cannot race;
* environment **values** are never sent to the browser — the drawer shows
  variable names only, and keys matching `pass|secret|token|credential|apikey|private`
  are redacted from the provider config view.

## Do not run Switchyard as root

Running the whole server as root would make every configured command
root-equivalent and would turn a single mistake in a YAML file into a system
compromise. Run it as your own user and grant only the specific extra rights you
need.

The server binds `127.0.0.1` by default and refuses any non-loopback address
unless `settings.allowRemoteBind: true` is set, because there is **no
authentication**: anything Switchyard can reach, a visitor to that port can
control.

## What each provider needs

### `command`

Exactly the rights of the Switchyard user. Design your services so this is
enough:

* unprivileged ports (>1024) — the example nginx instance uses 8480;
* a prefix, pid file and log files inside your own home;
* management scripts you own.

Nothing here needs a privilege grant. If a command *does* need one, prefer a
narrow sudoers rule over broadening what Switchyard itself can do.

### `systemd`

| Operation | Privilege |
| --- | --- |
| `systemctl show` (status) | none — any user may read unit properties |
| `journalctl -u` (logs, system scope) | membership in `systemd-journal` or `adm` |
| `start` / `stop` / `restart` / `reload`, system scope | polkit prompt (interactive) or a sudoers rule |
| everything, user scope (`scope: user`) | none — it is your own manager |

Prefer **user units** (`scope: user`, `useSudo: false`) whenever the service can
run as your user: no sudo, no polkit, no configuration outside your home.

For system units, Switchyard wraps mutating verbs in `sudo -n` (non-interactive)
so a missing rule fails immediately with a readable error instead of hanging on a
password prompt. Install a narrow rule — see
[`contrib/sudoers.d/switchyard.example`](../contrib/sudoers.d/switchyard.example):

```sudoers
# One unit, one verb set. No wildcards on the unit name.
youruser ALL=(root) NOPASSWD: /usr/bin/systemctl start chrony.service, \
                             /usr/bin/systemctl stop chrony.service, \
                             /usr/bin/systemctl restart chrony.service
```

Rules to follow when writing these:

* name the **exact** unit — always the literal unit name, never `systemctl *`
  or `systemctl restart *`;
* list only the verbs you actually want: weigh each one's actual risk, e.g.
  `stop` on a database against `reload` on a proxy;
* use the absolute path to `systemctl` — a relative name can be shadowed by
  `PATH`;
* validate with `sudo -l` and `visudo -c` before relying on it.

A polkit rule is the alternative if you prefer authorisation over sudo; it has
the same "name the unit explicitly" requirement.

### `compose` and `docker`

Talking to the Docker daemon means one of:

1. **Rootless Docker** (recommended for a workstation) — the daemon runs as your
   user, so a container escape lands in your account rather than in root's.
   Nothing extra to grant.
2. **Membership in the `docker` group** — convenient and the common setup, but be
   clear about what it means: the docker group is *root-equivalent*, because you
   can start a container that mounts `/` and runs privileged. Switchyard operates
   entirely within that existing access.
3. `sudo docker …` — possible via `dockerPath`, but a `sudo` rule for `docker`
   grants everything anyway, so it buys nothing over group membership.

Switchyard never invents container names or image references: `docker inspect`,
`docker start|stop|restart`, `docker pull <image from config>` and
`docker compose …` are built from configured values only.

Note which compose actions are destructive: `down` removes containers,
`down -v` (`destroy`) removes named volumes. Both are marked as confirm-required
and `destroy` is opt-in per service via `provider.actions`.

### nginx (via the `command` provider)

An unprivileged instance with its own prefix needs nothing. A system nginx on
port 80/443 needs root for start/stop/reload — in that case:

* prefer managing it through its systemd unit with a narrow sudoers rule, and
* keep the read-only `nginx -t` config test unprivileged where possible, so the
  most frequently used action needs no privilege at all.

## Hardening checklist

* [ ] Switchyard runs as your user, not root.
* [ ] `settings.host` is `127.0.0.1` (or you added authentication in front).
* [ ] `switchyard.yaml` and `services.d/` are owned by that user and not
      group-writable — anyone who can edit them can run commands as that user.
* [ ] sudoers rules name exact units and exact verbs, with absolute paths.
* [ ] Destructive actions (`stop`, `down`, `destroy`) have `confirm` set.
* [ ] You know whether your Docker is rootless or group-based, and are fine with
      the implication.
* [ ] Secrets are not written into service definitions; use `env` sparingly and
      remember that env values stay server-side but are visible to anyone who can
      read the file.

## What Switchyard deliberately does not do

* No shell. There is no `sh -c` anywhere in the execution path.
* No arbitrary command endpoint. There is no API that accepts a command line.
* No privilege escalation of its own: it has no setuid helper and does not manage
  sudoers or polkit for you.
* No writing to your configuration. `POST /api/reload` re-reads files from disk;
  nothing in the UI edits them.
