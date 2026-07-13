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
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from conftest import ADMIN_KEY, API_TIMEOUT, BOOT_TIMEOUT, EmulatedDevice

from streamline_tools.device.api import wait_for_api

pytestmark = pytest.mark.emulated

# QEMU's user-mode network exposes the host loopback to the guest here.
_SLIRP_HOST_ALIAS = "10.0.2.2"
# The two-slot layout from firmware/streamline/partitions.csv: a fresh image
# boots ota_0, and a successful OTA must land in and boot from ota_1.
_OTA_1_OFFSET = "0x210000"


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
def served_ota_image() -> Iterator[tuple[str, str]]:
    """The OTA application image served over HTTP as the guest reaches it:
    a (URL, sha256) pair. Skips when the image was not built."""
    source = os.environ.get("STREAMLINE_QEMU_OTA_IMAGE", "")
    if not source:
        pytest.skip("STREAMLINE_QEMU_OTA_IMAGE not set; build it with: make -C firmware qemu-artifacts")
    payload = Path(source).read_bytes()
    digest = hashlib.sha256(payload).hexdigest()

    class OtaImageHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format: str, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), OtaImageHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://{_SLIRP_HOST_ALIAS}:{server.server_address[1]}/streamline-qemu-ota.bin", digest
    finally:
        server.shutdown()


def test_ota_install_boots_from_the_other_slot(
    provisioned_device: EmulatedDevice,
    boot_device: Callable[..., EmulatedDevice],
    served_ota_image: tuple[str, str],
) -> None:
    url, sha256 = served_ota_image
    code, body = provisioned_device.api.post_form("/api/ota/update", {"url": url, "sha256": sha256})
    assert code == 202, f"OTA start was answered with HTTP {code}: {body[:200]!r}"

    # The device downloads through the emulated network, writes the inactive
    # slot, and reboots — which under -no-reboot ends the QEMU process.
    provisioned_device.dut.qemu.wait(timeout=180)

    updated = boot_device(flash=provisioned_device.flash, admin_key=ADMIN_KEY)
    updated.dut.expect_exact(f"Loaded app from partition at offset {_OTA_1_OFFSET}", timeout=BOOT_TIMEOUT)
    updated.dut.expect_exact("StreamLine provisioned", timeout=BOOT_TIMEOUT)
    _expect_api_up(updated)
    assert _mode(updated) == "provisioned"
