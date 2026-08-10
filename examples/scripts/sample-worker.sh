#!/usr/bin/env bash
#
# Example of a service that is managed by a hand-written script — the case the
# Switchyard "command" provider exists for.
#
# Switchyard calls this script as an argv array (no shell), one subcommand per
# configured action:
#
#   sample-worker.sh start | stop | restart | status | logs [-n N]
#
# `status` exits 0 when the worker is running and 1 when it is not, which is
# exactly what the command provider's `interpret: exit` mode expects.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="${SWITCHYARD_WORKER_STATE:-${here}/../../.state}"
pid_file="${state_dir}/sample-worker.pid"
log_file="${state_dir}/sample-worker.log"
interval="${SWITCHYARD_WORKER_INTERVAL:-5}"

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

do_run() {
  echo "$$" >"${pid_file}"
  trap 'rm -f "${pid_file}"; exit 0' TERM INT
  local tick=0
  printf '%s worker started (pid %s, interval %ss)\n' "$(date -Is)" "$$" "${interval}"
  while true; do
    tick=$((tick + 1))
    printf '%s tick %d\n' "$(date -Is)" "${tick}"
    sleep "${interval}"
  done
}

do_start() {
  if is_running; then
    echo "already running (pid $(read_pid))"
    return 0
  fi
  rm -f "${pid_file}"
  setsid "${BASH_SOURCE[0]}" __run >>"${log_file}" 2>&1 </dev/null &
  disown || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if is_running; then
      echo "started (pid $(read_pid))"
      return 0
    fi
    sleep 0.2
  done
  echo "worker did not come up; see ${log_file}" >&2
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
    local pid ticks
    pid="$(read_pid)"
    ticks="$(grep -c ' tick ' "${log_file}" 2>/dev/null || echo 0)"
    echo "worker running · pid ${pid} · ${ticks} ticks logged"
    return 0
  fi
  echo "worker not running"
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
  __run) do_run ;;
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
