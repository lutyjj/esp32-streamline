"""Smoke tests for the QEMU-emulated device: boot, HTTP API, provisioning cycle.

The QEMU image variant reaches the network over emulated Ethernet, so these
tests prove the same contracts a hardware device offers short of the radio
and audio path: clean boot, the read-only API surface, and a commissioning
write that must survive a reboot through the NVS generation machinery.
"""

import json
from collections.abc import Callable

from conftest import EmulatedDevice

from streamline_tools.smoke import wait_for_api
from streamline_tools.smoke_checks import api_checks

_BOOT_TIMEOUT = 120
_API_TIMEOUT = 60


def _status(device: EmulatedDevice) -> dict[str, object]:
    code, body = device.api.fetch("/api/status")
    assert code == 200, f"GET /api/status returned HTTP {code}"
    status = json.loads(body)
    assert isinstance(status, dict)
    return status


def _expect_api_up(device: EmulatedDevice) -> None:
    ready = wait_for_api(device.api.fetch, _API_TIMEOUT)
    assert ready.passed, ready.detail


def test_fresh_boot_reaches_setup_console(device: EmulatedDevice) -> None:
    device.dut.expect_exact("using board descriptor '", timeout=_BOOT_TIMEOUT)
    device.dut.expect_exact("emulated ethernet up", timeout=30)
    device.dut.expect_exact("setup console started", timeout=30)


def test_api_serves_status_and_contract(device: EmulatedDevice) -> None:
    device.dut.expect_exact("setup console started", timeout=_BOOT_TIMEOUT)
    _expect_api_up(device)
    results = api_checks(device.api.fetch)
    failed = [result for result in results if not result.passed]
    assert not failed, failed
    assert _status(device)["mode"] == "setup"


def test_provisioning_persists_across_reboot(boot_device: Callable[..., EmulatedDevice]) -> None:
    first_boot = boot_device()
    first_boot.dut.expect_exact("setup console started", timeout=_BOOT_TIMEOUT)
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
    second_boot.dut.expect_exact("StreamLine provisioned", timeout=_BOOT_TIMEOUT)
    _expect_api_up(second_boot)
    status = _status(second_boot)
    assert status["mode"] == "provisioned"
    assert isinstance(status["firmware_version"], str) and status["firmware_version"]
