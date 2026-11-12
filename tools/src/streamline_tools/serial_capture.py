#!/usr/bin/env python3
"""Bounded, non-interactive serial capture for CI and agents.

`espflash monitor` blocks forever waiting on a terminal — correct for a human,
unusable from a script. This runs it for a fixed number of seconds, streams its
output through unchanged, then stops it. espflash still owns port selection, the
reset handshake, and panic-backtrace decoding; this only adds the time box,
using the one timeout primitive present on macOS, Linux, and Windows alike:
Python's own subprocess.
"""

import argparse
import os
import subprocess
import sys
import threading


def _forward(source: int) -> None:
    """Copy espflash's diagnostics to this process's stderr as they arrive."""
    while chunk := os.read(source, 4096):
        sys.stderr.buffer.write(chunk)
        sys.stderr.buffer.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=20, help="capture window")
    parser.add_argument("--chip", default="esp32")
    parser.add_argument("--elf", help="ELF image for symbol/backtrace resolution")
    args, passthrough = parser.parse_known_args()

    command = [
        "espflash",
        "monitor",
        "--non-interactive",
        "--chip",
        args.chip,
    ]
    if args.elf:
        command += ["--elf", args.elf]
    command += passthrough

    try:
        # Device output streams live on the inherited stdout. espflash asks for a
        # port it cannot pick only on a terminal stderr, so its stderr runs
        # through a pipe: such a port fails at once instead of idling out the
        # window as a success.
        process = subprocess.Popen(command, stderr=subprocess.PIPE)
    except FileNotFoundError:
        print("espflash not found; install with: cargo install espflash", file=sys.stderr)
        return 2
    assert process.stderr is not None
    forwarder = threading.Thread(target=_forward, args=(process.stderr.fileno(),))
    forwarder.start()
    try:
        return process.wait(timeout=args.seconds)
    except subprocess.TimeoutExpired:
        return 0  # the fixed window elapsed: the intended, successful outcome
    except KeyboardInterrupt:
        return 130
    finally:
        # Killing the child releases the serial port and ends the forwarder.
        process.kill()
        process.wait()
        forwarder.join()
        process.stderr.close()


if __name__ == "__main__":
    sys.exit(main())
