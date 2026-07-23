"""Emulated-device smoke: boot, provisioning, security, recovery, and OTA.

These tests need what only the QEMU target offers — a fresh unprovisioned
flash, serial boot expectations, and destructive lifecycle transitions — so
they carry the `emulated` marker and skip on hardware targets. The
device-agnostic API contract lives in `test_device_api.py`.
"""

import dataclasses
import hashlib
import http.server
import json
import os
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import ADMIN_KEY, API_TIMEOUT, BOOT_TIMEOUT, EmulatedDevice

from streamline_tools.device.api import wait_for_api

pytestmark = pytest.mark.emulated

# QEMU's user-mode network exposes the host loopback to the guest here.
_SLIRP_HOST_ALIAS = "10.0.2.2"
# The two-slot layout from firmware/streamline/partitions.csv: a fresh image
# boots ota_0, and a successful OTA must land in and boot from ota_1.
_OTA_1_OFFSET = "0x210000"
_OTA_URL_CANARY = "ota-url-private-canary"


@dataclasses.dataclass(frozen=True)
class ServedOtaImage:
    download_url: str
    unavailable_url: str
    stalled_url: str
    forged_url: str
    sha256: str
    forged_sha256: str
    stall_started: threading.Event
    release_stall: threading.Event


# The application image ends with a 4 KB Secure Boot v2 signature sector; the
# signature block sits at its start. Corrupting a byte well inside that block
# leaves the image the digest covers untouched but makes the RSA signature fail
# to verify, standing in for firmware the device's key did not sign.
_SIGNATURE_SECTOR_BYTES = 4096
_SIGNATURE_BLOCK_OFFSET = 600


def _forge_signature(image: bytes) -> bytes:
    forged = bytearray(image)
    target = len(forged) - _SIGNATURE_SECTOR_BYTES + _SIGNATURE_BLOCK_OFFSET
    forged[target] ^= 0xFF
    return bytes(forged)


def _expect_api_up(device: EmulatedDevice) -> None:
    ready = wait_for_api(device.api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail


def _mode(device: EmulatedDevice) -> str:
    code, body = device.api.fetch("/api/status")
    assert code == 200, f"GET /api/status returned HTTP {code}"
    mode = json.loads(body)["mode"]
    assert isinstance(mode, str)
    return mode


def _led_role(device: EmulatedDevice, led_id: str) -> str:
    code, body = device.api.fetch("/api/settings")
    assert code == 200, f"GET /api/settings returned HTTP {code}"
    roles = {entry["id"]: entry["role"] for entry in json.loads(body)["led_roles"]}
    assert led_id in roles, f"settings did not report LED {led_id!r}: {roles}"
    return str(roles[led_id])


def _button_action(device: EmulatedDevice, button_id: str) -> str:
    code, body = device.api.fetch("/api/settings")
    assert code == 200, f"GET /api/settings returned HTTP {code}"
    actions = {entry["id"]: entry["action"] for entry in json.loads(body)["button_actions"]}
    assert button_id in actions, f"settings did not report button {button_id!r}: {actions}"
    return str(actions[button_id])


def _wait_for_ota_phase(device: EmulatedDevice, phase: str, timeout: float) -> dict[str, Any]:
    """Poll `/api/status` until the OTA worker reports `phase`.

    A device that answers this poll is one that did not reboot: a successful
    install reboots (ending the QEMU process under `-no-reboot`), so reaching a
    non-`installed` terminal phase while still serving HTTP is itself the proof
    the failure path left the running slot in place."""
    deadline = time.monotonic() + timeout
    last = "no status response"
    while time.monotonic() < deadline:
        try:
            code, body = device.api.fetch("/api/status")
        except OSError as error:
            last = str(error)
        else:
            if code == 200:
                ota = json.loads(body)["ota"]
                assert isinstance(ota, dict)
                if ota["phase"] == phase:
                    return ota
                last = f"phase={ota['phase']}"
        time.sleep(2.0)
    raise AssertionError(f"OTA did not reach phase {phase!r} within {timeout:.0f}s: {last}")


def _assert_ota_url_private(device: EmulatedDevice) -> dict[str, Any]:
    code, body = device.api.fetch("/api/status")
    assert code == 200, f"GET /api/status returned HTTP {code}"
    assert _OTA_URL_CANARY.encode() not in body, "custom OTA query leaked through device status or diagnostics"
    status: dict[str, Any] = json.loads(body)
    return status


def _assert_ota_url_absent_from_serial(device: EmulatedDevice) -> None:
    output = Path(device.dut.logfile).read_text(encoding="utf-8", errors="replace")
    assert _OTA_URL_CANARY not in output, "custom OTA query leaked through serial output"


def test_fresh_boot_reaches_setup_console(boot_device: Callable[..., EmulatedDevice]) -> None:
    device = boot_device()
    device.dut.expect_exact("using board descriptor '", timeout=BOOT_TIMEOUT)
    device.dut.expect_exact("emulated ethernet up", timeout=30)
    device.dut.expect_exact("setup console started", timeout=30)
    _expect_api_up(device)
    assert _mode(device) == "setup"


def test_provisioning_persists_across_reboot(provisioned_device: EmulatedDevice) -> None:
    # The fixture performed the commissioning write and the reboot; what is
    # left to assert is the durable outcome.
    assert _mode(provisioned_device) == "provisioned"
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    version = json.loads(body)["firmware_version"]
    assert isinstance(version, str) and version


def test_provisioned_device_gates_writes_behind_the_key(provisioned_device: EmulatedDevice) -> None:
    stranger = dataclasses.replace(provisioned_device.api, admin_key=None)
    code, _ = stranger.post_form("/api/settings/name", {"name": "intruder"})
    assert code == 401, f"unkeyed write was answered with HTTP {code}"

    imposter = dataclasses.replace(provisioned_device.api, admin_key="wrong-key-entirely")
    code, _ = imposter.post_form("/api/settings/name", {"name": "intruder"})
    assert code == 401, f"wrongly keyed write was answered with HTTP {code}"

    code, _ = provisioned_device.api.post_form("/api/settings/name", {"name": "qemu-renamed"})
    assert code == 200, f"keyed write was answered with HTTP {code}"
    code, body = provisioned_device.api.fetch("/api/settings")
    assert code == 200 and "qemu-renamed" in body.decode(errors="replace")


def test_local_output_intent_and_fault_are_reversible_without_a_codec(
    provisioned_device: EmulatedDevice,
) -> None:
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    status = json.loads(body)
    if status["capabilities"]["analog_passthrough"] is None:
        pytest.skip("the emulated board does not advertise a local output")

    code, body = provisioned_device.api.post_form("/api/settings/analog-passthrough", {"enabled": "true"})
    assert code == 503, f"unavailable local output was answered with HTTP {code}: {body[:200]!r}"
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    output = json.loads(body)["analog_passthrough"]
    assert output["enabled"] is True
    assert output["active"] is False
    assert isinstance(output["fault"], str) and output["fault"]

    code, body = provisioned_device.api.post_form("/api/settings/analog-passthrough", {"enabled": "false"})
    assert code == 200, f"local output off was answered with HTTP {code}: {body[:200]!r}"
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    assert json.loads(body)["analog_passthrough"] == {
        "enabled": False,
        "active": False,
        "fault": None,
    }


def test_led_role_assignment_persists_and_is_reversible(
    provisioned_device: EmulatedDevice, boot_device: Callable[..., EmulatedDevice]
) -> None:
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    leds = json.loads(body)["capabilities"]["leds"]
    status_led = next((led for led in leds if led["default_role"] == "status"), None)
    if status_led is None:
        pytest.skip("the emulated board advertises no status LED")
    led_id = status_led["id"]

    # An unknown LED id is a bad request, not a silent no-op.
    code, body = provisioned_device.api.post_form("/api/settings/led", {"id": "no-such-led", "role": "on"})
    assert code == 400, f"unknown LED id was answered with HTTP {code}: {body[:200]!r}"

    # Turn the status light off; the indicator then has no visible LED.
    code, body = provisioned_device.api.post_form("/api/settings/led", {"id": led_id, "role": "off"})
    assert code == 200, f"LED off was answered with HTTP {code}: {body[:200]!r}"
    assert _led_role(provisioned_device, led_id) == "off"
    code, body = provisioned_device.api.fetch("/api/status")
    assert json.loads(body)["indicator"]["available"] is False

    # The assignment lives in NVS, not just memory: it survives a reboot.
    code, _ = provisioned_device.api.post_form("/api/restart", {})
    assert code == 200
    provisioned_device.dut.qemu.wait(timeout=60)
    rebooted = boot_device(flash=provisioned_device.flash, admin_key=ADMIN_KEY)
    rebooted.dut.expect_exact("StreamLine provisioned", timeout=BOOT_TIMEOUT)
    _expect_api_up(rebooted)
    assert _led_role(rebooted, led_id) == "off"

    # Restore the status role and prove the indicator returns.
    code, body = rebooted.api.post_form("/api/settings/led", {"id": led_id, "role": "status"})
    assert code == 200, f"LED status restore was answered with HTTP {code}: {body[:200]!r}"
    assert _led_role(rebooted, led_id) == "status"
    code, body = rebooted.api.fetch("/api/status")
    assert json.loads(body)["indicator"]["available"] is True


def test_button_action_assignment_persists_and_is_reversible(
    provisioned_device: EmulatedDevice, boot_device: Callable[..., EmulatedDevice]
) -> None:
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    buttons = json.loads(body)["capabilities"]["buttons"]
    spare = next((button for button in buttons if button["default_action"] == "none"), None)
    if spare is None:
        pytest.skip("the emulated board advertises no unassigned button")
    button_id = spare["id"]

    # An unknown button id is a bad request, not a silent no-op.
    code, body = provisioned_device.api.post_form("/api/settings/button", {"id": "no-such-button", "action": "restart"})
    assert code == 400, f"unknown button id was answered with HTTP {code}: {body[:200]!r}"

    code, body = provisioned_device.api.post_form("/api/settings/button", {"id": button_id, "action": "toggle_stream"})
    assert code == 200, f"button assignment was answered with HTTP {code}: {body[:200]!r}"
    assert _button_action(provisioned_device, button_id) == "toggle_stream"

    # The assignment lives in NVS, not just memory: it survives a reboot.
    code, _ = provisioned_device.api.post_form("/api/restart", {})
    assert code == 200
    provisioned_device.dut.qemu.wait(timeout=60)
    rebooted = boot_device(flash=provisioned_device.flash, admin_key=ADMIN_KEY)
    rebooted.dut.expect_exact("StreamLine provisioned", timeout=BOOT_TIMEOUT)
    _expect_api_up(rebooted)
    assert _button_action(rebooted, button_id) == "toggle_stream"

    # Restore the descriptor default.
    code, body = rebooted.api.post_form("/api/settings/button", {"id": button_id, "action": "none"})
    assert code == 200, f"button restore was answered with HTTP {code}: {body[:200]!r}"
    assert _button_action(rebooted, button_id) == "none"


def test_stream_pause_is_unavailable_without_audio_capture(
    provisioned_device: EmulatedDevice,
) -> None:
    # Emulation runs no capture task, so there is nothing to pause; the
    # endpoint must fail closed instead of acknowledging a pause it cannot
    # perform, and status keeps reporting streaming as enabled.
    code, body = provisioned_device.api.post_form("/api/stream", {"enabled": "false"})
    assert code == 503, f"stream pause was answered with HTTP {code}: {body[:200]!r}"
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    assert json.loads(body)["stream"]["enabled"] is True


def test_factory_reset_returns_to_setup(
    provisioned_device: EmulatedDevice, boot_device: Callable[..., EmulatedDevice]
) -> None:
    code, body = provisioned_device.api.post_form("/api/factory-reset", {})
    assert code == 200, f"factory reset was answered with HTTP {code}: {body[:200]!r}"
    assert json.loads(body)["rebooting"] is True

    provisioned_device.dut.qemu.wait(timeout=60)
    wiped = boot_device(flash=provisioned_device.flash)
    wiped.dut.expect_exact("setup console started", timeout=BOOT_TIMEOUT)
    _expect_api_up(wiped)
    assert _mode(wiped) == "setup"


@pytest.fixture
def served_ota_image() -> Iterator[ServedOtaImage]:
    """The OTA application image served over HTTP as the guest reaches it:
    a (URL, sha256) pair. Skips when the image was not built."""
    source = os.environ.get("STREAMLINE_QEMU_OTA_IMAGE", "")
    if not source:
        pytest.skip("STREAMLINE_QEMU_OTA_IMAGE not set; build it with: make -C firmware qemu-artifacts")
    payload = Path(source).read_bytes()
    digest = hashlib.sha256(payload).hexdigest()
    forged = _forge_signature(payload)
    forged_digest = hashlib.sha256(forged).hexdigest()

    stall_started = threading.Event()
    release_stall = threading.Event()

    class OtaImageHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            path = self.path.partition("?")[0]
            if path == "/unavailable.bin":
                self.send_error(503)
                return
            body = forged if path == "/forged.bin" else payload
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if path == "/stalled.bin":
                try:
                    self.wfile.write(payload[:4096])
                    self.wfile.flush()
                    stall_started.set()
                    release_stall.wait(timeout=60)
                    self.wfile.write(payload[4096:])
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), OtaImageHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://{_SLIRP_HOST_ALIAS}:{server.server_address[1]}"
    query = f"?token={_OTA_URL_CANARY}"
    try:
        yield ServedOtaImage(
            download_url=f"{base}/streamline-qemu-ota.bin{query}",
            unavailable_url=f"{base}/unavailable.bin{query}",
            stalled_url=f"{base}/stalled.bin{query}",
            forged_url=f"{base}/forged.bin{query}",
            sha256=digest,
            forged_sha256=forged_digest,
            stall_started=stall_started,
            release_stall=release_stall,
        )
    finally:
        release_stall.set()
        server.shutdown()


def test_ota_install_boots_from_the_other_slot(
    provisioned_device: EmulatedDevice,
    boot_device: Callable[..., EmulatedDevice],
    served_ota_image: ServedOtaImage,
) -> None:
    code, body = provisioned_device.api.post_form(
        "/api/ota/update",
        {"url": served_ota_image.download_url, "sha256": served_ota_image.sha256},
    )
    assert code == 202, f"OTA start was answered with HTTP {code}: {body[:200]!r}"

    # The device downloads through the emulated network, writes the inactive
    # slot, and reboots — which under -no-reboot ends the QEMU process.
    provisioned_device.dut.qemu.wait(timeout=180)
    _assert_ota_url_absent_from_serial(provisioned_device)

    updated = boot_device(flash=provisioned_device.flash, admin_key=ADMIN_KEY)
    updated.dut.expect_exact(f"Loaded app from partition at offset {_OTA_1_OFFSET}", timeout=BOOT_TIMEOUT)
    updated.dut.expect_exact("StreamLine provisioned", timeout=BOOT_TIMEOUT)
    _expect_api_up(updated)
    assert _mode(updated) == "provisioned"
    status = _assert_ota_url_private(updated)
    assert "installed custom image" in status["diagnostics"]["last_ota"]


def test_ota_rejects_a_mismatched_checksum_and_keeps_the_running_slot(
    provisioned_device: EmulatedDevice,
    served_ota_image: ServedOtaImage,
) -> None:
    # Pin the real image to a digest it cannot match. The device accepts the
    # trigger, downloads, hashes, and must reject the payload the checksum does
    # not vouch for — the guarantee that makes an unverified image unbootable.
    code, body = provisioned_device.api.post_form(
        "/api/ota/update",
        {"url": served_ota_image.download_url, "sha256": "0" * 64},
    )
    assert code == 202, f"OTA start was answered with HTTP {code}: {body[:200]!r}"

    ota = _wait_for_ota_phase(provisioned_device, "failed", timeout=180)
    assert "checksum" in ota["message"].lower(), f"failed for the wrong reason: {ota['message']!r}"

    # A rejected install never switches slots, so the device stays on the image
    # it booted, still serving its API rather than rebooting into a bad slot.
    assert _mode(provisioned_device) == "provisioned"
    _assert_ota_url_private(provisioned_device)
    _assert_ota_url_absent_from_serial(provisioned_device)


def test_ota_rejects_a_forged_signature_and_keeps_the_running_slot(
    provisioned_device: EmulatedDevice,
    served_ota_image: ServedOtaImage,
) -> None:
    # The forged image's SHA-256 matches the caller's digest, so it clears the
    # integrity check, but a byte inside its RSA signature block is corrupted.
    # esp_ota must verify the vendor signature and refuse firmware the device's
    # key did not sign — the authenticity guarantee, distinct from the checksum.
    code, body = provisioned_device.api.post_form(
        "/api/ota/update",
        {"url": served_ota_image.forged_url, "sha256": served_ota_image.forged_sha256},
    )
    assert code == 202, f"OTA start was answered with HTTP {code}: {body[:200]!r}"

    ota = _wait_for_ota_phase(provisioned_device, "failed", timeout=180)
    assert "signature" in ota["message"].lower(), f"failed for the wrong reason: {ota['message']!r}"

    # A rejected install never switches slots, so the device stays on the signed
    # image it booted, still serving its API rather than rebooting into a bad one.
    assert _mode(provisioned_device) == "provisioned"
    _assert_ota_url_private(provisioned_device)
    _assert_ota_url_absent_from_serial(provisioned_device)


def test_ota_http_failure_keeps_the_custom_url_private(
    provisioned_device: EmulatedDevice,
    served_ota_image: ServedOtaImage,
) -> None:
    code, body = provisioned_device.api.post_form(
        "/api/ota/update",
        {"url": served_ota_image.unavailable_url, "sha256": served_ota_image.sha256},
    )
    assert code == 202, f"OTA start was answered with HTTP {code}: {body[:200]!r}"

    ota = _wait_for_ota_phase(provisioned_device, "failed", timeout=60)
    assert "HTTP 503" in ota["message"], ota
    _assert_ota_url_private(provisioned_device)
    _assert_ota_url_absent_from_serial(provisioned_device)


def test_ota_interruption_persists_only_a_redacted_recovery_note(
    provisioned_device: EmulatedDevice,
    boot_device: Callable[..., EmulatedDevice],
    served_ota_image: ServedOtaImage,
) -> None:
    code, body = provisioned_device.api.post_form(
        "/api/ota/update",
        {"url": served_ota_image.stalled_url, "sha256": served_ota_image.sha256},
    )
    assert code == 202, f"OTA start was answered with HTTP {code}: {body[:200]!r}"
    assert served_ota_image.stall_started.wait(timeout=30), "device did not start the stalled download"
    _wait_for_ota_phase(provisioned_device, "downloading", timeout=30)
    _assert_ota_url_private(provisioned_device)

    provisioned_device.dut.qemu.terminate()
    served_ota_image.release_stall.set()
    _assert_ota_url_absent_from_serial(provisioned_device)

    rebooted = boot_device(flash=provisioned_device.flash, admin_key=ADMIN_KEY)
    rebooted.dut.expect_exact("StreamLine provisioned", timeout=BOOT_TIMEOUT)
    _expect_api_up(rebooted)
    status = _assert_ota_url_private(rebooted)
    assert "installing custom image (did not finish)" in status["diagnostics"]["last_ota"]


def test_provisioned_device_reports_the_unemulated_codec_as_a_blocking_fault(
    provisioned_device: EmulatedDevice,
) -> None:
    # Emulation brings up no audio codec, which the boot flow reports as an audio
    # failure. That fact must reach the health verdict as a blocking codec fault,
    # proving boot facts flow into /api/health and drive its 503 status code.
    code, body = provisioned_device.api.fetch("/api/health")
    assert code == 503, f"health was answered with HTTP {code}"
    health = json.loads(body)
    assert health["status"] == "blocking", health
    codec = next((check for check in health["checks"] if check["id"] == "codec"), None)
    assert codec is not None and codec["status"] == "fail", health["checks"]

    # The console reads the same verdict from /api/status.
    code, body = provisioned_device.api.fetch("/api/status")
    assert code == 200
    assert json.loads(body)["health"]["status"] == "blocking"
