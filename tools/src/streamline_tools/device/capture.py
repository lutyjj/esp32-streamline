"""Bounded serial capture of one device boot.

Reads a serial-emitting process line by line until a boot-complete marker,
end of stream, or a deadline. espflash selects and owns the serial port, the
reset handshake, and panic decoding, exactly like `make firmware-capture`;
opening the USB serial adapter resets the board.
"""

import contextlib
import queue
import subprocess
import threading
import time
from collections.abc import Callable, Sequence
from typing import NamedTuple

from streamline_tools.device.boot_log import strip_ansi

# How long a process whose output closed gets to exit before its status is
# reported as unknown.
_EXIT_GRACE_SECONDS = 5.0


class Capture(NamedTuple):
    """One bounded read: the transcript and the marker it reached, if any.

    `ended` is true when the stream closed before a marker or the deadline;
    `exit_status` then holds the process's status once it has exited.
    """

    transcript: str
    marker: str | None
    ended: bool = False
    exit_status: int | None = None


def read_until(readline: Callable[[], str], markers: Sequence[str], timeout: float) -> Capture:
    """Collect lines until one contains a marker, EOF, or the timeout expires.

    `readline` may block indefinitely on a silent device, so a daemon thread
    feeds a queue and the deadline is enforced on the queue reads. The
    transcript runs up to and including the marker line.
    """
    lines: queue.Queue[str | None] = queue.Queue()

    def _reader() -> None:
        try:
            while True:
                line = readline()
                if line == "":
                    break
                lines.put(line)
        finally:
            lines.put(None)

    threading.Thread(target=_reader, daemon=True).start()
    deadline = time.monotonic() + timeout
    collected: list[str] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return Capture("".join(collected), None)
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            return Capture("".join(collected), None)
        if line is None:
            return Capture("".join(collected), None, ended=True)
        collected.append(line)
        plain = strip_ansi(line)
        for marker in markers:
            if marker in plain:
                return Capture("".join(collected), marker)


def pump_process(command: Sequence[str], markers: Sequence[str], timeout: float) -> Capture:
    """Run a serial-emitting process and read its output until a boot marker."""
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    assert process.stdout is not None
    try:
        capture = read_until(process.stdout.readline, markers, timeout)
        if capture.ended:
            with contextlib.suppress(subprocess.TimeoutExpired):
                return capture._replace(exit_status=process.wait(timeout=_EXIT_GRACE_SECONDS))
        return capture
    finally:
        process.kill()
        process.wait()


def serial_boot(markers: Sequence[str], timeout: float) -> Capture:
    """Reset the USB-connected board and capture one boot over serial."""
    command = ("espflash", "monitor", "--non-interactive", "--chip", "esp32")
    return pump_process(command, markers, timeout)
