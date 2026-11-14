"""Contract tests for waits that end when the emulator exits.

Each test drives a real pytest-embedded DUT over a serial file, the way the
QEMU service relays output, with only the QEMU process faked.
"""

import socket
import tempfile
import threading
import time
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest import mock

import pexpect
from pytest_embedded.dut import Dut
from pytest_embedded.log import PexpectProcess

from streamline_tools.device import emulator
from streamline_tools.device.api import wait_for_api
from streamline_tools.device.emulator import EmulatedApi, EmulatorExited, wait_for_marker


class FakeQemu:
    def __init__(self) -> None:
        self.status: int | None = None

    def poll(self) -> int | None:
        return self.status


class EmulatedDutTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        log = directory / "serial.txt"
        log.touch()
        self.serial = self.enterContext(log.open("ab", buffering=0))
        reader = self.enterContext(log.open("rb"))
        self.qemu = FakeQemu()
        self.dut: Any = Dut(
            pexpect_proc=PexpectProcess(reader),
            msg_queue=None,
            app=None,
            pexpect_logfile=str(log),
            test_case_name=self.id(),
            qemu=self.qemu,
        )

    def later(self, delay: float, action: Callable[[], object]) -> None:
        timer = threading.Timer(delay, action)
        timer.start()
        self.addCleanup(timer.cancel)


class WaitForMarkerTest(EmulatedDutTest):
    def test_returns_the_output_before_the_marker(self) -> None:
        self.serial.write(b"boot\nconsole ready\n")
        self.assertEqual(wait_for_marker(self.dut, "console ready", timeout=5), b"boot\n")

    def test_a_marker_still_in_the_relay_when_qemu_exits_matches(self) -> None:
        self.qemu.status = 0
        self.later(0.2, lambda: self.serial.write(b"firmware startup failed: test\n"))
        self.assertEqual(wait_for_marker(self.dut, "firmware startup failed:", timeout=60), b"")

    @mock.patch.object(emulator, "OUTPUT_DRAIN", 0.1)
    @mock.patch.object(emulator, "EXIT_TAIL_LINES", 40)
    def test_an_exit_fails_with_the_status_and_the_last_lines(self) -> None:
        self.serial.write(b"".join(b"line %d\r\n" % number for number in range(100)))
        self.qemu.status = 0
        with self.assertRaises(EmulatorExited) as raised:
            wait_for_marker(self.dut, "console ready", timeout=60)
        message = str(raised.exception)
        self.assertIn("status 0 before serial output showed 'console ready'", message)
        self.assertTrue(message.endswith("\n".join(f"line {number}" for number in range(60, 100))), message)
        self.assertNotIn("line 59", message)

    @mock.patch.object(emulator, "EXIT_POLL", 0.1)
    @mock.patch.object(emulator, "OUTPUT_DRAIN", 0.1)
    def test_an_exit_during_the_wait_ends_it(self) -> None:
        self.later(0.3, lambda: setattr(self.qemu, "status", 0))
        started = time.monotonic()
        with self.assertRaises(EmulatorExited):
            wait_for_marker(self.dut, "console ready", timeout=60)
        self.assertLess(time.monotonic() - started, 5)

    def test_a_running_qemu_times_out_at_the_deadline(self) -> None:
        started = time.monotonic()
        with self.assertRaises(pexpect.TIMEOUT) as raised:
            wait_for_marker(self.dut, "console ready", timeout=0.5)
        self.assertGreaterEqual(time.monotonic() - started, 0.5)
        self.assertEqual(str(raised.exception), "serial output never showed 'console ready'")


class EmulatedApiTest(EmulatedDutTest):
    def setUp(self) -> None:
        super().setUp()
        # A bound socket that never listens refuses every connection.
        refusing = self.enterContext(socket.socket())
        refusing.bind(("127.0.0.1", 0))
        self.api = EmulatedApi(base_url=f"http://127.0.0.1:{refusing.getsockname()[1]}", dut=self.dut)

    @mock.patch.object(emulator, "OUTPUT_DRAIN", 0.1)
    def test_a_failed_request_after_qemu_exits_names_the_exit(self) -> None:
        self.serial.write(b"Guru Meditation Error: Core  0 panic'ed (Double exception).\r\nRebooting...\r\n")
        self.qemu.status = 0
        with self.assertRaises(EmulatorExited) as raised:
            self.api.post_form("/api/restart", {})
        self.assertIn("status 0 and POST /api/restart failed", str(raised.exception))
        self.assertIn("Guru Meditation Error", str(raised.exception))

    @mock.patch.object(emulator, "OUTPUT_DRAIN", 0.1)
    def test_an_api_wait_stops_once_qemu_exits(self) -> None:
        self.qemu.status = 0
        started = time.monotonic()
        with self.assertRaises(EmulatorExited) as raised:
            wait_for_api(self.api.fetch, timeout=60)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("status 0 and GET /api/status failed", str(raised.exception))

    def test_a_failed_request_while_qemu_runs_stays_a_connection_error(self) -> None:
        with self.assertRaises(OSError):
            self.api.fetch("/api/status")


if __name__ == "__main__":
    unittest.main()
