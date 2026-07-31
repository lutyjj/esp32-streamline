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
_LED_ROLES = ("off", "on", "status")
_BUTTON_ACTIONS = (
    "none",
    "toggle_stream",
    "cycle_input",
    "gain_up",
    "gain_down",
    "attenuation_up",
    "attenuation_down",
    "restart",
    "factory_reset",
)


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


def test_local_output_status_matches_the_advertised_capability(device_api: DeviceApi) -> None:
    code, body = device_api.fetch("/api/status")
    assert code == 200
    status = json.loads(body)
    capability = status["capabilities"]["analog_passthrough"]
    output = status["analog_passthrough"]

    assert isinstance(output["enabled"], bool)
    assert isinstance(output["active"], bool)
    assert output["fault"] is None or isinstance(output["fault"], str)
    assert not output["active"] or output["enabled"]
    assert not output["active"] or output["fault"] is None

    if capability is None:
        assert output["enabled"] is False
        assert output["active"] is False
        return
    assert isinstance(capability["output_line"], int)
    assert capability["output_line"] > 0
    assert isinstance(capability["label"], str)
    assert capability["label"]


def test_led_capabilities_and_roles_are_coherent(device_api: DeviceApi) -> None:
    # The board advertises its LEDs; settings reports an effective role for each,
    # and the indicator is available exactly when one LED renders the status role.
    code, body = device_api.fetch("/api/status")
    assert code == 200
    status = json.loads(body)
    leds = status["capabilities"]["leds"]
    assert isinstance(leds, list)

    ids = []
    for led in leds:
        assert isinstance(led["id"], str) and led["id"]
        assert isinstance(led["label"], str) and led["label"]
        assert isinstance(led["gpio"], int)
        assert isinstance(led["active_low"], bool)
        assert led["default_role"] in _LED_ROLES
        ids.append(led["id"])
    assert len(ids) == len(set(ids)), f"duplicate LED ids: {ids}"

    code, body = device_api.fetch("/api/settings")
    assert code == 200
    roles = json.loads(body)["led_roles"]
    assert [entry["id"] for entry in roles] == ids, "led_roles must cover every capability LED in order"
    effective = {entry["id"]: entry["role"] for entry in roles}
    assert all(role in _LED_ROLES for role in effective.values()), effective

    indicator = status["indicator"]
    assert isinstance(indicator["available"], bool)
    assert indicator["available"] == any(role == "status" for role in effective.values())


def test_button_capabilities_and_actions_are_coherent(device_api: DeviceApi) -> None:
    # The board advertises its buttons; settings reports an effective action
    # for each, and streaming control state rides status for every client.
    code, body = device_api.fetch("/api/status")
    assert code == 200
    status = json.loads(body)
    buttons = status["capabilities"]["buttons"]
    assert isinstance(buttons, list)

    ids = []
    for button in buttons:
        assert isinstance(button["id"], str) and button["id"]
        assert isinstance(button["label"], str) and button["label"]
        assert isinstance(button["gpio"], int)
        assert isinstance(button["active_low"], bool)
        assert button["default_action"] in _BUTTON_ACTIONS
        ids.append(button["id"])
    assert len(ids) == len(set(ids)), f"duplicate button ids: {ids}"
    assert isinstance(status["stream"]["enabled"], bool)

    code, body = device_api.fetch("/api/settings")
    assert code == 200
    actions = json.loads(body)["button_actions"]
    assert [entry["id"] for entry in actions] == ids, "button_actions must cover every capability button in order"
    effective = {entry["id"]: entry["action"] for entry in actions}
    assert all(action in _BUTTON_ACTIONS for action in effective.values()), effective


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


def test_coredump_reads_stay_behind_the_admin_key(authed_device_api: DeviceApi) -> None:
    # A dump is a copy of device memory, so on a provisioned device both
    # coredump reads require the key, unlike the open reads.
    stranger = dataclasses.replace(authed_device_api, admin_key=None)
    for path in ("/api/coredump", "/api/coredump/image"):
        code, _ = stranger.fetch(path)
        assert code == 401, f"GET {path} without the key answered HTTP {code}"


def test_coredump_status_names_a_coherent_state(authed_device_api: DeviceApi) -> None:
    # A layout with the coredump partition answers 200 with a present flag; a
    # layout from before the partition existed answers 503. Both are healthy
    # states, and erase is idempotent, so this stays safe on a live board.
    code, body = authed_device_api.fetch("/api/coredump")
    assert code in (200, 503), f"GET /api/coredump answered HTTP {code}: {body[:200]!r}"
    if code == 503:
        image_code, _ = authed_device_api.fetch("/api/coredump/image")
        assert image_code == 503, f"image endpoint disagrees about availability: HTTP {image_code}"
        return
    status = json.loads(body)
    assert isinstance(status["present"], bool)
    assert isinstance(status["size_bytes"], int)
    assert status["present"] == (status["size_bytes"] > 0), status
    if status["present"]:
        pytest.skip("device holds a real crash dump; refusing to erase evidence")
    image_code, _ = authed_device_api.fetch("/api/coredump/image")
    assert image_code == 404, f"absent dump downloaded with HTTP {image_code}"
    # Erasing an empty store is the idempotent no-op that proves the endpoint
    # without destroying anything.
    erase_code, _ = authed_device_api.post_form("/api/coredump/erase", {})
    assert erase_code == 200, f"erase answered HTTP {erase_code}"


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
    # No stored previous image is a state conflict, not a bad request.
    assert code == 409, f"unavailable rollback was answered with HTTP {code}: {body[:200]!r}"
