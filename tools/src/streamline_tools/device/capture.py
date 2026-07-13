"""Bounded serial capture of one device boot.

Reads a serial-emitting process line by line until a boot-complete marker,
end of stream, or a deadline. espflash owns the serial port, the reset
handshake, and panic decoding, exactly like `make firmware-capture`; opening
the lab adapter always resets the board.
"""

import queue
import subprocess
import threading
import time
from collections.abc import Callable, Sequence

from streamline_tools.device.boot_log import strip_ansi


def read_until(readline: Callable[[], str], markers: Sequence[str], timeout: float) -> tuple[str, str | None]:
    """Collect lines until one contains a marker, EOF, or the timeout expires.

    `readline` may block indefinitely on a silent device, so a daemon thread
    feeds a queue and the deadline is enforced on the queue reads. Returns the
    transcript up to and including the marker line, and the matched marker
    (`None` on EOF or timeout).
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
            return "".join(collected), None
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            return "".join(collected), None
        if line is None:
            return "".join(collected), None
        collected.append(line)
        plain = strip_ansi(line)
        for marker in markers:
            if marker in plain:
                return "".join(collected), marker


def pump_process(command: Sequence[str], markers: Sequence[str], timeout: float) -> tuple[str, str | None]:
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
        return read_until(process.stdout.readline, markers, timeout)
    finally:
        process.kill()
        process.wait()


def serial_boot(port: str, markers: Sequence[str], timeout: float) -> tuple[str, str | None]:
    """Reset the USB-connected board and capture one boot over serial."""
    command = ("espflash", "monitor", "--non-interactive", "--chip", "esp32", "--port", port)
    return pump_process(command, markers, timeout)
