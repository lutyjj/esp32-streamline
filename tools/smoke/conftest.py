"""Fixtures for the QEMU smoke suite.

Each test boots its own copy of the QEMU firmware image
(`make -C firmware qemu-artifacts`, path in `STREAMLINE_QEMU_IMAGE`), so NVS
writes never leak between tests. The emulated device reaches the network
through QEMU's user-mode NIC; `api` talks to the device HTTP server through a
per-test host-forwarded port.
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

from streamline_tools.smoke import http_fetch, pad_flash_image

_HTTP_TIMEOUT = 10.0


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
    """The emulated device's HTTP surface through the forwarded port."""

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
def device(boot_device: Callable[..., EmulatedDevice]) -> EmulatedDevice:
    return boot_device()
