#!/usr/bin/env bash
#
# Registers this Switchyard's MCP server with Claude Code at *user* scope, so it is
# available in every project rather than only in this checkout.
#
#   scripts/switchyard-mcp-install.sh [http|stdio] [--dry-run]
#
# Why this script exists: the committed .mcp.json is project-scoped and portable
# because it uses ${CLAUDE_PROJECT_DIR}. That placeholder resolves to whatever
# project Claude Code is currently in, so it cannot be reused at user scope — a
# global entry has to name something that resolves the same everywhere. Two ways to
# get that, and this script does either:
#
#   http   a URL (default). Needs the daemon running; nothing in the entry points
#          into this checkout, so moving or renaming the directory changes nothing.
#   stdio  the `switchyard-mcp` bin, put on PATH with `npm link`. No daemon, but the
#          link does point at this checkout.
#
# The registration itself is machine-specific and therefore not committed — this
# script is the portable part.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/.." && pwd)"

mode="http"
dry_run=0
for arg in "$@"; do
  case "${arg}" in
    http | stdio) mode="${arg}" ;;
    --dry-run) dry_run=1 ;;
    -h | --help)
      sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '✗ unknown argument: %s (expected http, stdio or --dry-run)\n' "${arg}" >&2
      exit 2
      ;;
  esac
done

port="${SWITCHYARD_MCP_PORT:-7879}"
host="${SWITCHYARD_MCP_HOST:-127.0.0.1}"
path="${SWITCHYARD_MCP_PATH:-/mcp}"
name="${SWITCHYARD_MCP_NAME:-switchyard}"

run() {
  printf '· %s\n' "$*"
  if [[ "${dry_run}" -eq 0 ]]; then
    "$@"
  fi
}

command -v claude >/dev/null 2>&1 || {
  printf '✗ the `claude` CLI is not on PATH — install Claude Code first\n' >&2
  exit 1
}

[[ -f "${root}/packages/mcp/dist/index.js" ]] || {
  printf '✗ not built: run `npm run build` first\n' >&2
  exit 1
}

# A stale user-scope entry of the same name would make `add` fail, so clear it
# first and make this script safe to re-run after changing port or transport.
# Unconditional and ignoring failure on purpose: `claude mcp list` also shows the
# project-scoped entry from the committed .mcp.json, so testing the name there would
# try to remove a user entry that never existed — and that exits non-zero.
printf '· claude mcp remove --scope user %s (ignored if absent)\n' "${name}"
if [[ "${dry_run}" -eq 0 ]]; then
  claude mcp remove --scope user "${name}" >/dev/null 2>&1 || true
fi

if [[ "${mode}" == "http" ]]; then
  run claude mcp add --scope user --transport http "${name}" "http://${host}:${port}${path}"
  printf '\n✓ registered %s at user scope, reusable from every project\n' "${name}"
  printf '  The daemon has to be running for it to answer:\n'
  printf '    npm run mcp:http          # or scripts/switchyard-mcp-manage.sh start\n'
  printf '  To have Switchyard manage it, set `enabled: true` in\n'
  printf '  services.d/01-switchyard-mcp.yaml and reload the config.\n'
else
  # `npm link` puts the package's bin on PATH, so the entry needs no path of its
  # own. The symlink still points here, so this checkout has to stay put.
  run npm link --workspace @switchyard/mcp
  run claude mcp add --scope user "${name}" -- switchyard-mcp
  printf '\n✓ registered %s at user scope via the linked bin\n' "${name}"
  printf '  Claude Code spawns it per session; no daemon to manage.\n'
fi

printf '  Check it with: claude mcp list\n'
