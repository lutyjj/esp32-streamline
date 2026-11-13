"""Contract tests for the time-boxed serial capture script."""

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "src" / "streamline_tools" / "serial_capture.py"

# Stands in for espflash monitoring a board that keeps printing.
STREAMING_ESPFLASH = """#!/bin/sh
echo "rst:0x1 (POWERON_RESET)"
exec sleep 30
"""


class SerialCaptureTest(unittest.TestCase):
    def test_the_window_elapsing_succeeds_with_the_device_output(self) -> None:
        with tempfile.TemporaryDirectory() as bin_dir:
            fake = Path(bin_dir) / "espflash"
            fake.write_text(STREAMING_ESPFLASH)
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--seconds", "1"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                env=env,
                timeout=15,
            )
        self.assertEqual(result.returncode, 0)
        self.assertIn(b"POWERON_RESET", result.stdout)


if __name__ == "__main__":
    unittest.main()
