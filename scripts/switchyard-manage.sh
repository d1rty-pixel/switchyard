#!/usr/bin/env bash
#
# Lets Switchyard manage its own server process — same pattern as
# sample-worker.sh: detach via setsid, track liveness with a pid file.
#
#   switchyard-manage.sh start | stop | restart | rebuild | status | logs [-n N]
#
# `start` and `status` print the dashboard URL, read from the app's own
# "switchyard ready" log line (falls back to a best-effort guess from
# switchyard.yaml if the log hasn't caught up yet or is unreadable).
#
# Paired with the shipped services.d/00-switchyard.yaml, which manages the
# switchyard checkout it lives in with no path editing needed.
#
# Lives in scripts/ — real tooling that the shipped service definition drives.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/.." && pwd)"
state_dir="${SWITCHYARD_SELF_STATE:-${root}/.state}"
pid_file="${state_dir}/switchyard.pid"
log_file="${state_dir}/switchyard.log"

mkdir -p "${state_dir}"

# --- output -------------------------------------------------------------
# Colors off for non-tty stdout or when NO_COLOR is set (https://no-color.org).
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_dim=$'\033[2m'
  c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_cyan=$'\033[36m'
else
  c_reset=''; c_bold=''; c_dim=''; c_green=''; c_red=''; c_yellow=''; c_cyan=''
fi

ok()    { printf '%s✓%s %s\n' "${c_green}${c_bold}" "${c_reset}" "$*"; }
err()   { printf '%s✗%s %s\n' "${c_red}${c_bold}" "${c_reset}" "$*" >&2; }
info()  { printf '%s·%s %s\n' "${c_cyan}" "${c_reset}" "$*"; }
field() { printf '%s%s:%s %s' "${c_dim}" "$1" "${c_reset}" "$2"; }  # no trailing newline

# Docker's `host-gateway` extra_hosts magic resolves to the docker0 bridge's
# own IP, not a container's own network gateway — so that's the address we
# have to bind to for a container reaching us via host.docker.internal to
# land here. Prints nothing (and the caller falls back to loopback) if Docker
# isn't running or docker0 doesn't exist yet.
detect_docker_bridge_ip() {
  command -v ip >/dev/null 2>&1 || return 0
  ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1
}

# The server logs at debug level by default and never rotates its own stdout,
# so a long-running dev instance can grow this file without bound. One backup
# generation is enough here — this is a dev convenience, not a production log
# pipeline.
rotate_log_if_large() {
  local max_bytes="${SWITCHYARD_LOG_MAX_BYTES:-20971520}" # 20 MiB
  [[ -f "${log_file}" ]] || return 0
  local size
  size="$(stat -c%s "${log_file}" 2>/dev/null || echo 0)"
  (( size > max_bytes )) || return 0
  mv -f "${log_file}" "${log_file}.1"
  info "rotated oversized log (${size} bytes) -> $(basename "${log_file}").1"
}

read_pid() {
  [[ -f "${pid_file}" ]] || return 1
  local pid
  pid="$(cat "${pid_file}" 2>/dev/null || true)"
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "${pid}"
}

is_running() {
  local pid
  pid="$(read_pid)" || return 1
  kill -0 "${pid}" 2>/dev/null
}

# H:MM:SS (or D-H:MM:SS) the process has been up, empty if it isn't.
process_uptime() {
  local pid="$1"
  ps -o etime= -p "${pid}" 2>/dev/null | tr -d ' '
}

# Pulls the URL straight from the app's own "switchyard ready" log line —
# authoritative, since it reflects whatever it actually bound to (loopback or
# the docker-bridge override). Empty if jq is missing, the log has no such
# line yet, or the log file doesn't exist.
logged_url() {
  command -v jq >/dev/null 2>&1 || return 0
  [[ -f "${log_file}" ]] || return 0
  grep '"msg":"switchyard ready"' "${log_file}" 2>/dev/null \
    | tail -n1 \
    | jq -r '.url // empty' 2>/dev/null
}

# Best-effort read of settings.host/settings.port from switchyard.yaml, for
# when logged_url() came up empty. Defaults match the documented ones in
# README.md — good enough for a status line, not a substitute for the app's
# own config loading.
guessed_url() {
  local config="${SWITCHYARD_CONFIG:-${root}/switchyard.yaml}"
  local host="127.0.0.1" port=7878
  if [[ -f "${config}" ]]; then
    local found
    found="$(sed -n 's/^[[:space:]]*host:[[:space:]]*"\{0,1\}\([^"# ]*\).*/\1/p' "${config}" | head -n1)"
    [[ -n "${found}" ]] && host="${found}"
    found="$(sed -n 's/^[[:space:]]*port:[[:space:]]*"\{0,1\}\([^"# ]*\).*/\1/p' "${config}" | head -n1)"
    [[ -n "${found}" ]] && port="${found}"
  fi
  printf 'http://%s:%s/' "${host}" "${port}"
}

# Prints the URL, preferring the confirmed one; marks a guess as such.
dashboard_url() {
  local url
  url="$(logged_url)"
  if [[ -n "${url}" ]]; then
    printf '%s' "${url}"
  else
    printf '%s%s (unconfirmed)' "$(guessed_url)" "${c_dim}${c_reset}"
  fi
}

do_start() {
  if is_running; then
    info "already running (pid ${c_bold}$(read_pid)${c_reset})"
    return 0
  fi
  rotate_log_if_large
  rm -f "${pid_file}"
  cd "${root}"
  local -a bind_args=()
  local docker_ip
  docker_ip="$(detect_docker_bridge_ip)"
  if [[ -n "${docker_ip}" ]]; then
    bind_args=(--host "${docker_ip}")
    info "docker detected · binding to ${c_bold}${docker_ip}${c_reset} instead of loopback"
  fi
  setsid node packages/server/dist/index.js "${bind_args[@]}" >>"${log_file}" 2>&1 </dev/null &
  echo "$!" >"${pid_file}"
  disown || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_running; then
      ok "started · $(field pid "${c_bold}$(read_pid)${c_reset}")  $(field url "${c_cyan}$(dashboard_url)${c_reset}")"
      return 0
    fi
    sleep 0.2
  done
  err "switchyard did not come up; see ${log_file}"
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

do_rebuild() {
  do_stop
  # Stop first so the rebuilt dist/ isn't loaded by a process already running
  # against the old one, and so `start` picks up the fresh build, not the stale one.
  cd "${root}"
  info "building…"
  npm run build
  do_start
}

do_status() {
  if is_running; then
    local pid uptime
    pid="$(read_pid)"
    uptime="$(process_uptime "${pid}")"
    ok "running · $(field pid "${c_bold}${pid}${c_reset}")  $(field uptime "${uptime:-?}")  $(field url "${c_cyan}$(dashboard_url)${c_reset}")"
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
  rebuild) do_rebuild ;;
  status) do_status ;;
  logs)
    shift
    do_logs "$@"
    ;;
  *)
    err "usage: $(basename "$0") {start|stop|restart|rebuild|status|logs [-n N]}"
    exit 2
    ;;
esac
