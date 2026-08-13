#!/usr/bin/env python3
"""
Synthetic load, used to exercise Switchyard's resource monitoring end to end.

Burns a *configurable fraction* of the CPU, holds a fixed amount of memory and
optionally writes to disk at a steady rate — deliberately not "as much as
possible", because the interesting cases are values that sit above one threshold
and below the next, long enough for a sustained-breach rule to fire.

One process, so the `command` provider's `/proc` sampling covers all of it:
`utime + stime` includes every thread this process starts, and none of the
provider's numbers would cover a forked child. CPU above 100 % is produced with
more than one worker thread — 100 % is one busy core.

Configuration comes from the environment (the wrapper script passes it through):

  LOAD_CPU_PERCENT   total CPU to aim for, in percent of one core (default 45)
  LOAD_MEMORY_MB     resident memory to hold (default 220)
  LOAD_DISK_KBPS     disk writes per second in KiB, 0 disables (default 4096)
  LOAD_PID_FILE      pid file to write (required)
  LOAD_SCRATCH_FILE  file used for the disk writes

The CPU duty cycle is enforced per 100 ms slice, so the average stays close to
the target instead of oscillating between 0 and 100 %.
"""

import hashlib
import os
import signal
import sys
import threading
import time

SLICE_SECONDS = 0.1
STOP = threading.Event()


def env_number(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"invalid {name}={raw!r}, using {default}", flush=True)
        return default


def burn(target_percent: float) -> None:
    """Work for `target_percent` of each time slice, sleep for the rest.

    The work is `sha256` over a fixed buffer rather than a Python arithmetic
    loop, because hashlib releases the GIL for buffers of this size. A
    pure-Python loop does not, so several burn threads would take turns and the
    whole process would never exceed ~100 % however many threads it started —
    which is precisely the case this generator needs to be able to produce.
    """
    payload = b"x" * 262144
    busy = SLICE_SECONDS * min(max(target_percent, 0.0), 100.0) / 100.0
    idle = SLICE_SECONDS - busy
    while not STOP.is_set():
        deadline = time.perf_counter() + busy
        # The perf_counter check keeps the slice honest without depending on how
        # fast one hash happens to be on this machine.
        while time.perf_counter() < deadline:
            hashlib.sha256(payload).digest()
        if idle > 0:
            STOP.wait(idle)


def write_disk(kbps: float, path: str) -> None:
    """Rewrites the same file every second, so nothing grows without bound."""
    chunk = b"x" * 1024
    per_second = int(kbps)
    while not STOP.is_set():
        started = time.perf_counter()
        try:
            # O_DSYNC would make this a latency test instead of a throughput one;
            # an fsync per second is enough to make the bytes reach the device and
            # show up in /proc/<pid>/io write_bytes.
            with open(path, "wb") as handle:
                for _ in range(per_second):
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as error:
            print(f"disk write failed: {error}", flush=True)
            return
        elapsed = time.perf_counter() - started
        if elapsed < 1.0:
            STOP.wait(1.0 - elapsed)


def main() -> int:
    pid_file = os.environ.get("LOAD_PID_FILE", "").strip()
    if not pid_file:
        print("LOAD_PID_FILE is required", file=sys.stderr)
        return 2

    cpu_percent = env_number("LOAD_CPU_PERCENT", 45.0)
    memory_mb = env_number("LOAD_MEMORY_MB", 220.0)
    disk_kbps = env_number("LOAD_DISK_KBPS", 4096.0)
    scratch = os.environ.get("LOAD_SCRATCH_FILE", "").strip()

    with open(pid_file, "w", encoding="utf8") as handle:
        handle.write(str(os.getpid()))

    def shutdown(*_args: object) -> None:
        STOP.set()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # Touched once so the pages are really resident, not just reserved.
    ballast = bytearray(int(memory_mb) * 1024 * 1024)
    for offset in range(0, len(ballast), 4096):
        ballast[offset] = 1

    # One thread can contribute at most 100 %; spread the target over as few
    # threads as will carry it.
    workers = max(1, int((cpu_percent + 99.0) // 100.0))
    per_worker = cpu_percent / workers
    print(
        f"load generator pid {os.getpid()}: cpu {cpu_percent:.0f}% over {workers} thread(s), "
        f"memory {memory_mb:.0f} MiB, disk {disk_kbps:.0f} KiB/s",
        flush=True,
    )

    threads = [threading.Thread(target=burn, args=(per_worker,), daemon=True) for _ in range(workers)]
    if disk_kbps > 0 and scratch:
        threads.append(threading.Thread(target=write_disk, args=(disk_kbps, scratch), daemon=True))
    for thread in threads:
        thread.start()

    while not STOP.is_set():
        STOP.wait(1.0)

    print("load generator stopping", flush=True)
    try:
        os.unlink(pid_file)
    except OSError:
        pass
    if scratch:
        try:
            os.unlink(scratch)
        except OSError:
            pass
    # Keeps the ballast alive until here, so it cannot be collected early.
    del ballast
    return 0


if __name__ == "__main__":
    sys.exit(main())
