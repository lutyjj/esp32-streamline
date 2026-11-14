"""Waits on a QEMU-emulated device that end when QEMU exits.

pytest-embedded relays QEMU's output into a file that pexpect reads and that
never ends, so pexpect never sees QEMU exit. These waits check the QEMU process
instead and fail with its last serial output, which holds any guest panic.
"""

import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import pexpect

from streamline_tools.device.api import DeviceApi
from streamline_tools.device.boot_log import serial_marker

# A serial wait checks this often whether QEMU still runs.
EXIT_POLL = 1.0
# How long the output QEMU wrote before it exited gets to reach the expect stream.
OUTPUT_DRAIN = 5.0
# A request fails when QEMU closes its sockets on exit, a moment before the exit can be reaped.
EXIT_GRACE = 1.0
# Serial lines an exit failure quotes; a dual-core ESP-IDF panic report runs about 35.
EXIT_TAIL_LINES = 80
# pexpect is not thread-safe, and requests from several threads can fail at once.
_drain = threading.Lock()


class EmulatorExited(pexpect.EOF):
    """QEMU exited while a test still needed the device."""


def wait_for_marker(dut: Any, marker: str, timeout: float) -> bytes:
    """Wait for a serial marker from a pytest-embedded QEMU DUT and return the output before it.

    Raises `EmulatorExited` once QEMU has exited without printing the marker,
    and `pexpect.TIMEOUT` if QEMU still runs at the deadline.
    """
    pattern = serial_marker(marker)
    deadline = time.monotonic() + timeout
    while True:
        status = dut.qemu.poll()
        wait = OUTPUT_DRAIN if status is not None else min(EXIT_POLL, max(deadline - time.monotonic(), 0.0))
        try:
            before: bytes = dut.expect(pattern, timeout=wait, return_what_before_match=True)
            return before
        except pexpect.TIMEOUT as error:
            if status is not None:
                raise _exited(status, f"before serial output showed {marker!r}", dut.pexpect_proc.before) from error
            if time.monotonic() >= deadline:
                # pytest-embedded names the missing pattern, which is an unreadable regular expression.
                raise pexpect.TIMEOUT(f"serial output never showed {marker!r}") from error


def check_running(dut: Any, failure: str) -> None:
    """Raise `EmulatorExited` if the QEMU behind a pytest-embedded DUT exits within `EXIT_GRACE`."""
    try:
        status = dut.qemu.wait(timeout=EXIT_GRACE)
    except subprocess.TimeoutExpired:
        return
    with _drain:
        output: bytes = dut.expect(pexpect.TIMEOUT, timeout=OUTPUT_DRAIN)
    raise _exited(status, failure, output)


@dataclass(frozen=True)
class EmulatedApi(DeviceApi):
    """An emulated device's API: a request that fails because QEMU exited says so."""

    dut: Any = field(kw_only=True, repr=False, compare=False)

    def fetch(self, path: str) -> tuple[int, bytes]:
        try:
            return super().fetch(path)
        except OSError:
            check_running(self.dut, f"and GET {path} failed")
            raise

    def post_form(self, path: str, fields: dict[str, str]) -> tuple[int, bytes]:
        try:
            return super().post_form(path, fields)
        except OSError:
            check_running(self.dut, f"and POST {path} failed")
            raise


def _exited(status: int, failure: str, output: bytes) -> EmulatorExited:
    tail = b"\n".join(output.splitlines()[-EXIT_TAIL_LINES:]).decode(errors="replace")
    return EmulatorExited(f"QEMU exited with status {status} {failure}. Its last output:\n{tail}")
