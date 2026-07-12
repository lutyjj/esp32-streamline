"""Emulated-device smoke: boot markers and the provisioning cycle.

These tests need what only the QEMU target offers — a fresh unprovisioned
flash and serial boot expectations — so they carry the `emulated` marker and
skip on hardware targets. The device-agnostic API contract lives in
`test_device_api.py`.
"""

import json
from collections.abc import Callable

import pytest
from conftest import API_TIMEOUT, BOOT_TIMEOUT, EmulatedDevice

from streamline_tools.smoke import wait_for_api

pytestmark = pytest.mark.emulated


def _expect_api_up(device: EmulatedDevice) -> None:
    ready = wait_for_api(device.api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail


def _mode(device: EmulatedDevice) -> str:
    code, body = device.api.fetch("/api/status")
    assert code == 200, f"GET /api/status returned HTTP {code}"
    mode = json.loads(body)["mode"]
    assert isinstance(mode, str)
    return mode


def test_fresh_boot_reaches_setup_console(boot_device: Callable[..., EmulatedDevice]) -> None:
    device = boot_device()
    device.dut.expect_exact("using board descriptor '", timeout=BOOT_TIMEOUT)
    device.dut.expect_exact("emulated ethernet up", timeout=30)
    device.dut.expect_exact("setup console started", timeout=30)
    _expect_api_up(device)
    assert _mode(device) == "setup"


def test_provisioning_persists_across_reboot(boot_device: Callable[..., EmulatedDevice]) -> None:
    first_boot = boot_device()
    first_boot.dut.expect_exact("setup console started", timeout=BOOT_TIMEOUT)
    _expect_api_up(first_boot)

    # First commissioning must establish an admin key; this one is synthetic
    # and lives only inside the throwaway emulated flash. The full 200 body
    # must arrive before the device reboots — clients block on it.
    code, body = first_boot.api.post_form(
        "/api/settings/wifi",
        {"ssid": "qemu-smoke-lab", "admin_secret": "qemu-smoke-admin"},
    )
    assert code == 200, f"commissioning write returned HTTP {code}: {body[:200]!r}"
    assert json.loads(body)["rebooting"] is True

    # The settings write restarts the device, which under -no-reboot ends the
    # QEMU process; waiting for that exit also guarantees the flash file is
    # released. Booting a second process on the same flash proves the
    # commissioning write survived the reboot in NVS, not process memory.
    first_boot.dut.qemu.wait(timeout=60)
    second_boot = boot_device(flash=first_boot.flash)
    second_boot.dut.expect_exact("StreamLine provisioned", timeout=BOOT_TIMEOUT)
    _expect_api_up(second_boot)
    assert _mode(second_boot) == "provisioned"
