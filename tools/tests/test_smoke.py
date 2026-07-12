"""Contract tests for the smoke runner: flash padding, transcript pumping, API wait."""

import time
import unittest
from collections.abc import Iterator

from streamline_tools.smoke import pad_flash_image, read_until, wait_for_api

MEBIBYTE = 1024 * 1024


def readline_from(lines: list[str]) -> Iterator[str]:
    yield from lines
    while True:
        yield ""


def merged_image(size_field: int, length: int) -> bytes:
    """A minimal merged flash image: bootloader magic and flash-size header at 0x1000."""
    image = bytearray(b"\x00" * length)
    image[0x1000] = 0xE9
    image[0x1003] = size_field << 4
    return bytes(image)


class PadFlashImageTest(unittest.TestCase):
    def test_pads_to_the_declared_flash_size_with_erased_bytes(self) -> None:
        length = 2 * MEBIBYTE - 1  # smaller than 2 MiB, yet the header declares 4 MiB
        padded = pad_flash_image(merged_image(0x2, length))
        self.assertEqual(len(padded), 4 * MEBIBYTE)
        self.assertEqual(padded[length:], b"\xff" * (4 * MEBIBYTE - length))

    def test_image_at_exactly_its_declared_size_is_unchanged(self) -> None:
        image = merged_image(0x1, 2 * MEBIBYTE)
        self.assertEqual(pad_flash_image(image), image)

    def test_image_larger_than_its_declared_size_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pad_flash_image(merged_image(0x1, 2 * MEBIBYTE + 1))

    def test_missing_bootloader_magic_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pad_flash_image(b"\x00" * MEBIBYTE)

    def test_unsupported_declared_size_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pad_flash_image(merged_image(0x0, MEBIBYTE))  # 1 MiB flash: no QEMU model


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


class WaitForApiTest(unittest.TestCase):
    def test_immediate_success_passes(self) -> None:
        item = wait_for_api(lambda path: (200, b"{}"), timeout=5.0)
        self.assertTrue(item.passed)

    def test_never_reachable_fails_with_last_error(self) -> None:
        def fetch(path: str) -> tuple[int, bytes]:
            raise OSError("connection refused")

        item = wait_for_api(fetch, timeout=0.0)
        self.assertFalse(item.passed)
        self.assertIn("no response", item.detail)


if __name__ == "__main__":
    unittest.main()
