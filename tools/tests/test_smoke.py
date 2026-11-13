"""Contract tests for the device smoke's boot verdict."""

import unittest

from streamline_tools.device.capture import Capture
from streamline_tools.smoke import boot_completed


class BootCompletedTest(unittest.TestCase):
    def test_espflash_exiting_is_reported_with_its_status(self) -> None:
        result = boot_completed(Capture("error\n", None, ended=True, exit_status=3), boot_timeout=150.0)
        self.assertFalse(result.passed)
        self.assertIn("exit status 3", result.detail)
        self.assertNotIn("150s", result.detail)

    def test_a_closed_stream_without_an_exit_status_is_not_reported_as_an_exit(self) -> None:
        result = boot_completed(Capture("", None, ended=True), boot_timeout=150.0)
        self.assertFalse(result.passed)
        self.assertIn("exit status unknown", result.detail)

    def test_the_deadline_passing_is_reported_as_a_timeout(self) -> None:
        result = boot_completed(Capture("boot\n", None), boot_timeout=150.0)
        self.assertFalse(result.passed)
        self.assertIn("within 150s", result.detail)


if __name__ == "__main__":
    unittest.main()
