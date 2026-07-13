"""Device-agnostic API smoke: identical against QEMU and real hardware.

Every test here runs on both targets — an emulated device booted for the test,
or a provisioned board on the LAN (`STREAMLINE_SMOKE_TARGET=http://...`) — so a
board proves the same contract pre-silicon and on arrival. Read-only tests take
`device_api`; tests that need the admin key take `authed_device_api` and stay
non-destructive so they are safe against a live board. Behavior that only the
emulator can produce lives in `test_qemu_device.py` behind the `emulated` marker.
"""

import dataclasses
import json

import pytest

from streamline_tools.device.api import DeviceApi, api_checks

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


def test_health_status_code_tracks_the_verdict(device_api: DeviceApi) -> None:
    code, body = device_api.fetch("/api/health")
    assert code in (200, 503), f"health endpoint answered HTTP {code}"
    health = json.loads(body)
    assert isinstance(health, dict) and isinstance(health.get("checks"), list)
    # The scriptable liveness contract a monitor relies on: the status code is
    # 503 exactly when the verdict is blocking, and 200 otherwise.
    assert (code == 503) == (health["status"] == "blocking"), health


def test_metrics_are_scriptable(device_api: DeviceApi) -> None:
    code, body = device_api.fetch("/api/metrics")
    assert code == 200, f"metrics endpoint answered HTTP {code}"
    text = body.decode(errors="replace")
    # Prometheus exposition with the always-present build/mode series.
    assert "# HELP" in text and "streamline_firmware_info" in text


def test_unlock_accepts_the_key_and_rejects_the_rest(authed_device_api: DeviceApi) -> None:
    # The stateless key check the console unlocks with: the real key passes, and
    # a wrong one is refused — the same gate every authenticated write rides.
    code, _ = authed_device_api.post_form("/api/unlock", {})
    assert code == 200, f"the admin key was rejected at unlock with HTTP {code}"

    imposter = dataclasses.replace(authed_device_api, admin_key="wrong-key-entirely")
    code, _ = imposter.post_form("/api/unlock", {})
    assert code == 401, f"a wrong key was accepted at unlock with HTTP {code}"


def test_ota_rejects_a_partial_custom_image_request(authed_device_api: DeviceApi) -> None:
    # A custom install pins content by digest, so a URL without its sha256 must
    # be refused outright — never silently downgraded to a latest-release pull.
    code, body = authed_device_api.post_form("/api/ota/update", {"url": "http://198.51.100.9/streamline.bin"})
    assert code == 400, f"partial custom-image request was answered with HTTP {code}: {body[:200]!r}"


def test_rollback_is_refused_when_no_slot_is_available(authed_device_api: DeviceApi) -> None:
    # Rollback must refuse when there is no valid previous slot rather than point
    # the next boot at an empty one. A device that *does* have a rollback slot
    # would reboot into the other image, so only the safe state is exercised —
    # which is exactly the guard under test.
    code, body = authed_device_api.fetch("/api/status")
    assert code == 200
    ota = json.loads(body)["ota"]
    if ota["rollback_available"]:
        pytest.skip("device has a valid rollback slot; refusing to reboot it to test the guard")

    code, body = authed_device_api.post_form("/api/ota/rollback", {})
    assert code == 400, f"unavailable rollback was answered with HTTP {code}: {body[:200]!r}"
