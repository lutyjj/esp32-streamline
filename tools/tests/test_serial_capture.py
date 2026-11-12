"""Contract tests for the time-boxed serial capture script."""

import os
import pty
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "src" / "streamline_tools" / "serial_capture.py"

# Stands in for espflash: it waits at a port prompt whenever its stderr is a
# terminal, as dialoguer does, and otherwise fails the way espflash does when
# it cannot pick a port.
PROMPTING_ESPFLASH = """#!/bin/sh
if [ -t 2 ]; then
  echo "Use serial port '/dev/ttyUSB0'?" >&2
  exec sleep 30
fi
echo "Error: no serial port selected" >&2
exit 1
"""

# Stands in for espflash monitoring a board that keeps printing.
STREAMING_ESPFLASH = """#!/bin/sh
echo "rst:0x1 (POWERON_RESET)"
exec sleep 30
"""


def run_capture(espflash: str, seconds: int) -> tuple[int, bytes, bytes, float]:
    """Run the script with a fake espflash first on PATH and a terminal on stderr.

    Returns the exit status, stdout, what reached the terminal, and the elapsed time.
    """
    with tempfile.TemporaryDirectory() as bin_dir:
        fake = Path(bin_dir) / "espflash"
        fake.write_text(espflash)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
        terminal, stderr = pty.openpty()
        started = time.monotonic()
        try:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--seconds", str(seconds)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=stderr,
                env=env,
                timeout=seconds + 15,
            )
            elapsed = time.monotonic() - started
        finally:
            os.close(stderr)
        shown = b""
        try:
            while chunk := os.read(terminal, 4096):
                shown += chunk
        except OSError:
            pass  # Linux reports EIO once the last writer has closed.
        finally:
            os.close(terminal)
    return result.returncode, result.stdout, shown, elapsed


class SerialCaptureTest(unittest.TestCase):
    def test_a_port_espflash_cannot_pick_fails_without_waiting_at_a_prompt(self) -> None:
        status, _, shown, elapsed = run_capture(PROMPTING_ESPFLASH, seconds=5)
        self.assertEqual(status, 1)
        self.assertIn(b"no serial port selected", shown)
        self.assertNotIn(b"Use serial port", shown)
        self.assertLess(elapsed, 5)

    def test_the_window_elapsing_succeeds_with_the_device_output(self) -> None:
        status, stdout, _, elapsed = run_capture(STREAMING_ESPFLASH, seconds=1)
        self.assertEqual(status, 0)
        self.assertIn(b"POWERON_RESET", stdout)
        self.assertLess(elapsed, 10)


if __name__ == "__main__":
    unittest.main()
