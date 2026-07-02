#!/usr/bin/env python3
"""Bounded, non-interactive serial capture for CI and agents.

`espflash monitor` blocks forever waiting on a terminal — correct for a human,
unusable from a script. This runs it for a fixed number of seconds, streams its
output through unchanged, then stops it. espflash still owns the reset handshake
and panic-backtrace decoding; this only adds the time box, using the one timeout
primitive present on macOS, Linux, and Windows alike: Python's own subprocess.
"""

import argparse
import subprocess
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=20, help="capture window")
    parser.add_argument("--port", required=True)
    parser.add_argument("--chip", default="esp32")
    parser.add_argument("--elf", help="ELF image for symbol/backtrace resolution")
    args, passthrough = parser.parse_known_args()

    command = [
        "espflash",
        "monitor",
        "--non-interactive",
        "--chip",
        args.chip,
        "--port",
        args.port,
    ]
    if args.elf:
        command += ["--elf", args.elf]
    command += passthrough

    try:
        # Inherit stdio so output streams live; on expiry the child is killed and
        # the OS releases the serial port.
        return subprocess.run(command, timeout=args.seconds).returncode
    except subprocess.TimeoutExpired:
        return 0  # the fixed window elapsed: the intended, successful outcome
    except FileNotFoundError:
        print("espflash not found; install with: cargo install espflash", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
