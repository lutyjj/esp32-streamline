"""Contract tests for boot-transcript and API smoke checks."""

import json
import unittest

from streamline_tools.smoke_checks import CheckResult, api_checks, boot_checks, strip_ansi

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


class ApiChecksTest(unittest.TestCase):
    def test_healthy_api_passes(self) -> None:
        bodies = {
            "/api/status": json.dumps({"mode": "provisioned", "firmware_version": "0.5.5"}),
            "/api/openapi.json": json.dumps({"openapi": "3.1.0"}),
        }
        results = api_checks(lambda path: (200, bodies[path].encode()))
        self.assertTrue(all(item.passed for item in results), results)
        self.assertIn("mode=provisioned", result(results, "status-readable").detail)

    def test_http_error_status_fails(self) -> None:
        results = api_checks(lambda path: (503, b""))
        self.assertFalse(result(results, "status-readable").passed)
        self.assertIn("503", result(results, "status-readable").detail)

    def test_invalid_json_fails(self) -> None:
        results = api_checks(lambda path: (200, b"<html>not json</html>"))
        self.assertFalse(result(results, "status-readable").passed)

    def test_missing_status_fields_fail(self) -> None:
        results = api_checks(lambda path: (200, json.dumps({"openapi": "3.1.0", "mode": "provisioned"}).encode()))
        item = result(results, "status-readable")
        self.assertFalse(item.passed)
        self.assertIn("firmware_version", item.detail)

    def test_connection_error_fails_instead_of_raising(self) -> None:
        def fetch(path: str) -> tuple[int, bytes]:
            raise OSError("connection refused")

        results = api_checks(fetch)
        self.assertFalse(result(results, "status-readable").passed)
        self.assertIn("connection refused", result(results, "status-readable").detail)


if __name__ == "__main__":
    unittest.main()
