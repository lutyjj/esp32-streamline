"""Device-agnostic API smoke: identical against QEMU and real hardware.

These tests see the device only through `device_api`, so the same contract
is proven wherever the suite points: an emulated device booted for the test,
or a provisioned board on the LAN (`STREAMLINE_SMOKE_TARGET=http://...`).
"""

import json

from conftest import DeviceApi

from streamline_tools.smoke_checks import api_checks

_MODES = ("setup", "recovery", "provisioned")


def test_api_serves_status_and_contract(device_api: DeviceApi) -> None:
    results = api_checks(device_api.fetch)
    failed = [result for result in results if not result.passed]
    assert not failed, failed


def test_status_reports_a_valid_mode(device_api: DeviceApi) -> None:
    code, body = device_api.fetch("/api/status")
    assert code == 200
    status = json.loads(body)
    assert status["mode"] in _MODES, f"unknown mode {status['mode']!r}"
    assert isinstance(status["firmware_version"], str) and status["firmware_version"]


def test_health_is_scriptable(device_api: DeviceApi) -> None:
    code, body = device_api.fetch("/api/health")
    assert code in (200, 503), f"health endpoint answered HTTP {code}"
    health = json.loads(body)
    assert isinstance(health, dict) and "status" in health
