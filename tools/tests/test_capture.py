"""Contract tests for bounded serial capture."""

import time
import unittest
from collections.abc import Iterator

from streamline_tools.device.capture import read_until


def readline_from(lines: list[str]) -> Iterator[str]:
    yield from lines
    while True:
        yield ""


class ReadUntilTest(unittest.TestCase):
    def test_stops_at_the_first_marker_line(self) -> None:
        lines = readline_from(["boot\n", "using board descriptor 'x'\n", "after\n"])
        transcript, matched = read_until(lambda: next(lines), ("using board descriptor '",), timeout=5.0)
        self.assertEqual(matched, "using board descriptor '")
        self.assertIn("boot\n", transcript)
        self.assertNotIn("after", transcript)

    def test_matches_marker_under_ansi_color(self) -> None:
        lines = readline_from(["\x1b[32msetup AP started: esp32-streamline-abc\x1b[0m\n"])
        _, matched = read_until(lambda: next(lines), ("setup AP started:",), timeout=5.0)
        self.assertEqual(matched, "setup AP started:")

    def test_eof_returns_transcript_without_match(self) -> None:
        lines = readline_from(["only line\n"])
        transcript, matched = read_until(lambda: next(lines), ("never",), timeout=5.0)
        self.assertIsNone(matched)
        self.assertEqual(transcript, "only line\n")

    def test_silent_stream_times_out_instead_of_hanging(self) -> None:
        def silent_readline() -> str:
            time.sleep(0.5)
            return "too late\n"

        started = time.monotonic()
        transcript, matched = read_until(silent_readline, ("never",), timeout=0.05)
        self.assertLess(time.monotonic() - started, 0.4)
        self.assertIsNone(matched)
        self.assertEqual(transcript, "")


if __name__ == "__main__":
    unittest.main()
