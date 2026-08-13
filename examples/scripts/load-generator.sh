#!/usr/bin/env bash
#
# Wrapper around load-generator.py, in the shape the Switchyard `command`
# provider expects: one subcommand per action, `status` exiting 0 when the
# generator runs and non-zero when it does not.
#
#   load-generator.sh start | start-heavy | stop | restart | status | logs [-n N]
#
# `start` produces a moderate load that sits above a "warning" threshold and
# below a "critical" one; `start-heavy` goes over both, which is what exercises
# the warning → critical escalation path. Everything is a single process, so the
# provider's /proc sampling accounts for all of it.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="${SWITCHYARD_LOAD_STATE:-${here}/../../.state}"
pid_file="${state_dir}/load-generator.pid"
log_file="${state_dir}/load-generator.log"
scratch_file="${state_dir}/load-generator.scratch"
generator="${here}/load-generator.py"

# Moderate by default: ~45 % of one core, a fixed 220 MiB resident, 4 MiB/s of
# writes. Override any of them from the service definition's `env:` block.
cpu_percent="${LOAD_CPU_PERCENT:-45}"
memory_mb="${LOAD_MEMORY_MB:-220}"
disk_kbps="${LOAD_DISK_KBPS:-4096}"
heavy_cpu_percent="${LOAD_HEAVY_CPU_PERCENT:-260}"
heavy_memory_mb="${LOAD_HEAVY_MEMORY_MB:-900}"

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

do_start() {
  local cpu="$1" memory="$2"
  if is_running; then
    echo "already running (pid $(read_pid))"
    return 0
  fi
  rm -f "${pid_file}"
  LOAD_PID_FILE="${pid_file}" \
  LOAD_SCRATCH_FILE="${scratch_file}" \
  LOAD_CPU_PERCENT="${cpu}" \
  LOAD_MEMORY_MB="${memory}" \
  LOAD_DISK_KBPS="${disk_kbps}" \
    setsid python3 "${generator}" >>"${log_file}" 2>&1 </dev/null &
  disown || true
  for _ in $(seq 1 25); do
    if is_running; then
      echo "load generator started (pid $(read_pid)) · cpu ${cpu}% · memory ${memory} MiB · disk ${disk_kbps} KiB/s"
      return 0
    fi
    sleep 0.2
  done
  echo "load generator did not come up; see ${log_file}" >&2
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
  rm -f "${pid_file}" "${scratch_file}"
  echo "stopped (was pid ${pid})"
}

do_status() {
  if is_running; then
    echo "generating load · pid $(read_pid) · $(tail -n 1 "${log_file}" 2>/dev/null || echo 'no log yet')"
    return 0
  fi
  echo "idle — no load being generated"
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
  start) do_start "${cpu_percent}" "${memory_mb}" ;;
  start-heavy) do_start "${heavy_cpu_percent}" "${heavy_memory_mb}" ;;
  stop) do_stop ;;
  restart)
    do_stop
    do_start "${cpu_percent}" "${memory_mb}"
    ;;
  status) do_status ;;
  logs)
    shift
    do_logs "$@"
    ;;
  *)
    echo "usage: $(basename "$0") {start|start-heavy|stop|restart|status|logs [-n N]}" >&2
    exit 2
    ;;
esac
