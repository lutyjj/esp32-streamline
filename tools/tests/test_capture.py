"""Contract tests for bounded serial capture."""

import sys
import time
import unittest
from collections.abc import Iterator

from streamline_tools.device.capture import pump_process, read_until


def readline_from(lines: list[str]) -> Iterator[str]:
    yield from lines
    while True:
        yield ""


class ReadUntilTest(unittest.TestCase):
    def test_stops_at_the_first_marker_line(self) -> None:
        lines = readline_from(["boot\n", "using board descriptor 'x'\n", "after\n"])
        capture = read_until(lambda: next(lines), ("using board descriptor '",), timeout=5.0)
        self.assertEqual(capture.marker, "using board descriptor '")
        self.assertIn("boot\n", capture.transcript)
        self.assertNotIn("after", capture.transcript)

    def test_matches_marker_under_ansi_color(self) -> None:
        lines = readline_from(["\x1b[32msetup AP started: esp32-streamline-abc\x1b[0m\n"])
        capture = read_until(lambda: next(lines), ("setup AP started:",), timeout=5.0)
        self.assertEqual(capture.marker, "setup AP started:")

    def test_eof_reports_the_stream_ended_without_a_match(self) -> None:
        lines = readline_from(["only line\n"])
        capture = read_until(lambda: next(lines), ("never",), timeout=5.0)
        self.assertIsNone(capture.marker)
        self.assertTrue(capture.ended)
        self.assertEqual(capture.transcript, "only line\n")

    def test_silent_stream_times_out_instead_of_hanging(self) -> None:
        def silent_readline() -> str:
            time.sleep(0.5)
            return "too late\n"

        started = time.monotonic()
        capture = read_until(silent_readline, ("never",), timeout=0.05)
        self.assertLess(time.monotonic() - started, 0.4)
        self.assertIsNone(capture.marker)
        self.assertFalse(capture.ended)
        self.assertEqual(capture.transcript, "")


class PumpProcessTest(unittest.TestCase):
    def test_a_process_that_exits_first_reports_its_exit_status(self) -> None:
        command = (sys.executable, "-c", "print('No serial ports could be detected'); raise SystemExit(3)")
        capture = pump_process(command, ("never",), timeout=10.0)
        self.assertTrue(capture.ended)
        self.assertEqual(capture.exit_status, 3)
        self.assertIn("No serial ports", capture.transcript)


if __name__ == "__main__":
    unittest.main()
