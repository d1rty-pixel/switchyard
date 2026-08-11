#!/usr/bin/env bash
#
# Lets Switchyard manage its own server process — same pattern as
# sample-worker.sh: detach via setsid, track liveness with a pid file.
#
#   switchyard-manage.sh start | stop | restart | status | logs [-n N]
#
# `start` prints the dashboard URL once the server is up, read from
# switchyard.yaml (falling back to the documented defaults).
#
# Paired with examples/services.d/13-switchyard-self.yaml, which is "as-is":
# copy it into services.d/ and it manages the switchyard checkout it lives in,
# no path editing needed.
#
# Lives in scripts/ — real tooling that the example service definition drives.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${here}/.." && pwd)"
state_dir="${SWITCHYARD_SELF_STATE:-${root}/.state}"
pid_file="${state_dir}/switchyard.pid"
log_file="${state_dir}/switchyard.log"

mkdir -p "${state_dir}"

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

# Best-effort read of settings.host/settings.port from switchyard.yaml, for the
# "started, open it here" message. Defaults match the documented ones in
# README.md — good enough for a status line, not a substitute for the app's
# own config loading.
dashboard_url() {
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

do_start() {
  if is_running; then
    echo "already running (pid $(read_pid))"
    return 0
  fi
  rm -f "${pid_file}"
  cd "${root}"
  setsid node packages/server/dist/index.js >>"${log_file}" 2>&1 </dev/null &
  echo "$!" >"${pid_file}"
  disown || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_running; then
      echo "started (pid $(read_pid)) · $(dashboard_url)"
      return 0
    fi
    sleep 0.2
  done
  echo "switchyard did not come up; see ${log_file}" >&2
  return 1
}

do_stop() {
  if ! is_running; then
    echo "not running"
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
  echo "stopped (was pid ${pid})"
}

do_status() {
  if is_running; then
    echo "switchyard running · pid $(read_pid)"
    return 0
  fi
  echo "switchyard not running"
  return 1
}

do_logs() {
  local lines=50
  if [[ "${1:-}" == "-n" && -n "${2:-}" ]]; then
    lines="$2"
  fi
  [[ -f "${log_file}" ]] || { echo "no log file yet: ${log_file}"; return 0; }
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
    echo "usage: $(basename "$0") {start|stop|restart|status|logs [-n N]}" >&2
    exit 2
    ;;
esac
