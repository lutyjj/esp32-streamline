"""Fixtures for the device smoke suite.

The suite runs against two targets and the tests do not care which:
`STREAMLINE_SMOKE_TARGET` is either unset/`qemu` — each test boots its own
flash copy of the QEMU image variant (`make -C firmware qemu-artifacts`,
path in `STREAMLINE_QEMU_IMAGE`) — or a real device's base URL such as
`http://192.0.2.10`. Tests that need an emulated device (a fresh
unprovisioned flash, serial boot markers) carry the `emulated` marker and
are skipped on hardware targets.
"""

import os
import shutil
import socket
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from pytest_embedded.dut_factory import DutFactory

from streamline_tools.smoke import http_fetch, pad_flash_image, wait_for_api

BOOT_TIMEOUT = 120.0
API_TIMEOUT = 60.0
_HTTP_TIMEOUT = 10.0


def _hardware_url() -> str | None:
    """The real-device base URL, or None when the target is QEMU."""
    target = os.environ.get("STREAMLINE_SMOKE_TARGET", "qemu")
    return None if target in ("", "qemu") else target.rstrip("/")


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "emulated: requires the QEMU-emulated device")


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if _hardware_url() is None:
        return
    skip = pytest.mark.skip(reason="requires the QEMU-emulated device; this run targets real hardware")
    for item in items:
        if "emulated" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def padded_image(tmp_path_factory: pytest.TempPathFactory) -> Path:
    source = os.environ.get("STREAMLINE_QEMU_IMAGE", "")
    if not source:
        pytest.fail(
            "STREAMLINE_QEMU_IMAGE must point at a merged image; build one with: make -C firmware qemu-artifacts"
        )
    image = tmp_path_factory.mktemp("image") / "flash.bin"
    image.write_bytes(pad_flash_image(Path(source).read_bytes()))
    return image


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@dataclass(frozen=True)
class DeviceApi:
    """One device's HTTP surface, hardware and emulated alike."""

    base_url: str

    def fetch(self, path: str) -> tuple[int, bytes]:
        return http_fetch(self.base_url, path)

    def post_form(self, path: str, fields: dict[str, str]) -> tuple[int, bytes]:
        request = urllib.request.Request(
            self.base_url + path,
            data=urllib.parse.urlencode(fields).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()


@dataclass(frozen=True)
class EmulatedDevice:
    """One booted QEMU device: its serial expectations, API, and flash file."""

    dut: Any
    api: DeviceApi
    flash: Path


@pytest.fixture
def boot_device(padded_image: Path, tmp_path: Path) -> Callable[..., EmulatedDevice]:
    """Boot an emulated device on a fresh flash copy, or re-boot an existing one.

    A guest-initiated restart is out of contract under QEMU (the emulated NIC
    survives a warm reset and crashes the next boot), so `-no-reboot` turns
    every reset into a QEMU exit. Persistence across reboots is proven by
    booting a second QEMU process on the same flash file.
    """

    def _boot(flash: Path | None = None) -> EmulatedDevice:
        if flash is None:
            flash = tmp_path / f"flash-{len(list(tmp_path.glob('flash-*.bin')))}.bin"
            shutil.copy(padded_image, flash)
        port = _free_port()
        dut = DutFactory.create(
            embedded_services="qemu",
            qemu_image_path=str(flash),
            skip_regenerate_image=True,
            qemu_extra_args=f"-no-reboot -nic user,model=open_eth,hostfwd=tcp:127.0.0.1:{port}-:80",
        )
        return EmulatedDevice(dut=dut, api=DeviceApi(base_url=f"http://127.0.0.1:{port}"), flash=flash)

    return _boot


@pytest.fixture
def device_api(request: pytest.FixtureRequest) -> DeviceApi:
    """The device under test, reduced to what every target offers: its API.

    Hardware target: the configured base URL. QEMU target: a freshly booted
    emulated device. Tests using only this fixture run identically on both.
    """
    url = _hardware_url()
    if url is not None:
        api = DeviceApi(base_url=url)
    else:
        boot: Callable[..., EmulatedDevice] = request.getfixturevalue("boot_device")
        device = boot()
        device.dut.expect_exact("setup console started", timeout=BOOT_TIMEOUT)
        api = device.api
    ready = wait_for_api(api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail
    return api
