"""Contract tests for boot-transcript analysis."""

import unittest

from streamline_tools.device.boot_log import boot_checks, strip_ansi
from streamline_tools.device.checks import CheckResult

HEALTHY_BOOT = """\
rst:0x1 (POWERON_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)
I (700) boot: ESP-IDF v5.5.3 2nd stage bootloader
I (1147) boot: Loaded app from partition at offset 0x20000
I (2007) app_init: App version:      v0.5.5
I (2040) main_task: Calling app_main()
I (2250) streamline_firmware: using board descriptor 'ai-thinker-esp32-audio-kit-v2-2-es8388'
"""

PANICKING_BOOT = (
    HEALTHY_BOOT
    + """\
W (2540) periph_ctrl: phy module clock bits 0x0, required 0x8f8f
assert failed: esp_phy_enable phy_init.c:327 (phy_module_has_clock_bits(...))
"""
)


def result(results: list[CheckResult], check: str) -> CheckResult:
    matches = [item for item in results if item.check == check]
    assert len(matches) == 1, f"expected exactly one {check!r} result"
    return matches[0]


class BootChecksTest(unittest.TestCase):
    def test_healthy_boot_passes_every_check(self) -> None:
        results = boot_checks(HEALTHY_BOOT)
        self.assertTrue(all(item.passed for item in results), results)

    def test_board_descriptor_and_version_are_reported(self) -> None:
        results = boot_checks(HEALTHY_BOOT)
        self.assertIn("ai-thinker-esp32-audio-kit-v2-2-es8388", result(results, "board-descriptor-resolved").detail)
        self.assertIn("v0.5.5", result(results, "firmware-version-reported").detail)

    def test_assert_failure_fails_no_panic_with_the_line(self) -> None:
        item = result(boot_checks(PANICKING_BOOT), "no-panic")
        self.assertFalse(item.passed)
        self.assertIn("esp_phy_enable", item.detail)

    def test_each_panic_marker_is_detected(self) -> None:
        for marker_line in (
            "Guru Meditation Error: Core 0 panic'ed (LoadProhibited)",
            "abort() was called at PC 0x400893a1",
            "assert failed: foo bar.c:1 (cond)",
            "thread 'main' panicked at src/main.rs:10:5:",
        ):
            with self.subTest(marker_line=marker_line):
                item = result(boot_checks(HEALTHY_BOOT + marker_line + "\n"), "no-panic")
                self.assertFalse(item.passed)

    def test_second_reset_banner_fails_booted_once(self) -> None:
        item = result(boot_checks(HEALTHY_BOOT + "rst:0xc (SW_CPU_RESET),boot:0x12\n"), "booted-once")
        self.assertFalse(item.passed)
        self.assertIn("2", item.detail)

    def test_missing_app_main_fails_that_check_only(self) -> None:
        transcript = HEALTHY_BOOT.replace("I (2040) main_task: Calling app_main()\n", "")
        results = boot_checks(transcript)
        self.assertFalse(result(results, "app-main-started").passed)
        self.assertTrue(result(results, "bootloader-loaded-app").passed)

    def test_ansi_colored_transcript_still_matches(self) -> None:
        colored = HEALTHY_BOOT.replace("Calling app_main()", "\x1b[32mCalling app_main()\x1b[0m")
        self.assertTrue(result(boot_checks(colored), "app-main-started").passed)

    def test_strip_ansi_removes_color_codes(self) -> None:
        self.assertEqual(strip_ansi("\x1b[0;32mI (1) boot:\x1b[0m ok"), "I (1) boot: ok")


if __name__ == "__main__":
    unittest.main()
