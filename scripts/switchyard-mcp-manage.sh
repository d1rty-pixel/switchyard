#!/usr/bin/env bash
#
# Runs the Switchyard MCP server as a background daemon — the same setsid plus
# pid-file pattern switchyard-manage.sh uses for the server itself.
#
#   switchyard-mcp-manage.sh start | stop | restart | status | logs [-n N]
#
# Only meaningful for the HTTP transport. In stdio mode the client spawns the
# process and owns its lifetime, so there is nothing here to start or stop.
#
# Paired with the shipped services.d/01-switchyard-mcp.yaml, which is disabled by
# default: flip `enabled: true` in it to see the daemon on the dashboard.
#
# Overrides, all optional:
#   SWITCHYARD_MCP_PORT   listen port (default 7879)
#   SWITCHYARD_MCP_HOST   bind address, loopback only (default 127.0.0.1)
#   SWITCHYARD_URL        Switchyard API the tools talk to (default :7878)

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/.." && pwd)"
state_dir="${SWITCHYARD_SELF_STATE:-${root}/.state}"
pid_file="${state_dir}/switchyard-mcp.pid"
log_file="${state_dir}/switchyard-mcp.log"
entry="${root}/packages/mcp/dist/index.js"

port="${SWITCHYARD_MCP_PORT:-7879}"
host="${SWITCHYARD_MCP_HOST:-127.0.0.1}"

mkdir -p "${state_dir}"

# --- output -------------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
  c_green=$'\033[32m'; c_red=$'\033[31m'; c_cyan=$'\033[36m'
else
  c_reset=''; c_bold=''; c_dim=''; c_green=''; c_red=''; c_cyan=''
fi

ok()    { printf '%s✓%s %s\n' "${c_green}${c_bold}" "${c_reset}" "$*"; }
err()   { printf '%s✗%s %s\n' "${c_red}${c_bold}" "${c_reset}" "$*" >&2; }
info()  { printf '%s·%s %s\n' "${c_cyan}" "${c_reset}" "$*"; }
field() { printf '%s%s:%s %s' "${c_dim}" "$1" "${c_reset}" "$2"; }

read_pid() {
  [[ -f "${pid_file}" ]] || return 1
  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "${pid}"
}

# Same one-generation rotation as switchyard-manage.sh — this log never
# rotates on its own and can otherwise grow without bound.
rotate_log_if_large() {
  local max_bytes="${SWITCHYARD_LOG_MAX_BYTES:-20971520}" # 20 MiB
  [[ -f "${log_file}" ]] || return 0
  local size
  size="$(stat -c%s "${log_file}" 2>/dev/null || echo 0)"
  (( size > max_bytes )) || return 0
  mv -f "${log_file}" "${log_file}.1"
  info "rotated oversized log (${size} bytes) -> $(basename "${log_file}").1"
}

is_running() {
  local pid
  pid="$(read_pid)" || return 1
  kill -0 "${pid}" 2>/dev/null
}

process_uptime() {
  ps -o etime= -p "$1" 2>/dev/null | tr -d ' '
}

endpoint() {
  printf 'http://%s:%s%s' "${host}" "${port}" "${SWITCHYARD_MCP_PATH:-/mcp}"
}

do_start() {
  if is_running; then
    info "already running (pid ${c_bold}$(read_pid)${c_reset})"
    return 0
  fi
  if [[ ! -f "${entry}" ]]; then
    err "not built: ${entry} — run npm run build"
    return 1
  fi
  rotate_log_if_large
  rm -f "${pid_file}"
  cd "${root}"
  setsid node "${entry}" --http --host "${host}" --port "${port}" \
    >>"${log_file}" 2>&1 </dev/null &
  echo "$!" >"${pid_file}"
  disown || true
  for _ in $(seq 1 15); do
    if is_running; then
      ok "started · $(field pid "${c_bold}$(read_pid)${c_reset}")  $(field endpoint "${c_cyan}$(endpoint)${c_reset}")"
      return 0
    fi
    sleep 0.2
  done
  err "switchyard-mcp did not come up; see ${log_file}"
  return 1
}

do_stop() {
  if ! is_running; then
    info "not running"
    rm -f "${pid_file}"
    return 0
  fi
  local pid
  pid="$(read_pid)"
  kill -TERM "${pid}" 2>/dev/null || true
  for _ in $(seq 1 25); do
    is_running || break
    sleep 0.2
  done
  if is_running; then
    kill -KILL "${pid}" 2>/dev/null || true
    sleep 0.2
  fi
  rm -f "${pid_file}"
  ok "stopped (was pid ${c_bold}${pid}${c_reset})"
}

do_status() {
  if is_running; then
    local pid uptime
    pid="$(read_pid)"
    uptime="$(process_uptime "${pid}")"
    ok "running · $(field pid "${c_bold}${pid}${c_reset}")  $(field uptime "${uptime:-?}")  $(field endpoint "${c_cyan}$(endpoint)${c_reset}")"
    return 0
  fi
  err "not running"
  return 1
}

do_logs() {
  local lines=50
  if [[ "${1:-}" == "-n" && -n "${2:-}" ]]; then
    lines="$2"
  fi
  [[ -f "${log_file}" ]] || { info "no log file yet: ${log_file}"; return 0; }
  tail -n "${lines}" "${log_file}"
}

case "${1:-}" in
  start) do_start ;;
  stop) do_stop ;;
  restart)
    do_stop
    do_start
    ;;
  status) do_status ;;
  logs)
    shift
    do_logs "$@"
    ;;
  *)
    err "usage: $(basename "$0") {start|stop|restart|status|logs [-n N]}"
    exit 2
    ;;
esac
