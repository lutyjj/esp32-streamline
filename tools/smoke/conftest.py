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
import warnings
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pexpect
import pytest
from pytest_embedded.dut_factory import DutFactory
from pytest_embedded_qemu.qemu import QEMU_TARGETS

from streamline_tools.device.api import DeviceApi, wait_for_api
from streamline_tools.device.flash_image import pad_flash_image
from streamline_tools.secret_input import read_secret_fd

BOOT_TIMEOUT = 120.0
# A boot occasionally panics before its marker: a flash operation disables the
# cache while the second core still runs code from it ("Cache disabled but
# cached memory region accessed"), and `-no-reboot` turns the reset into a dead
# QEMU. That is an emulation artifact, so a boot that never arrives is retried
# on a fresh emulator; a guest that cannot boot still fails.
BOOT_ATTEMPTS = 2
# Bounded like BOOT_TIMEOUT rather than tighter: under parallel workers
# (SMOKE_JOBS) concurrent emulator boots dilate the gap between the serial
# boot marker and a listening HTTP port, and the serial expectation has
# already proven the device alive.
API_TIMEOUT = 120.0
# Synthetic commissioning credential; it exists only inside throwaway
# emulated flash copies.
# The canonical admin-key shape: exactly 48 lowercase hex characters. Built
# from a repeated character so secret scanners see no entropy in a test key.
ADMIN_KEY = "a" * 48


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
class EmulatedDevice:
    """One booted QEMU device: its serial expectations, API, and flash file."""

    dut: Any
    api: DeviceApi
    flash: Path


@pytest.fixture
def boot_device(padded_image: Path, tmp_path: Path) -> Iterator[Callable[..., EmulatedDevice]]:
    """Boot an emulated device on a fresh flash copy, or re-boot an existing one.

    A guest-initiated restart is out of contract under QEMU (the emulated NIC
    survives a warm reset and crashes the next boot), so `-no-reboot` turns
    every reset into a QEMU exit. Persistence across reboots is proven by
    booting a second QEMU process on the same flash file. Every QEMU this
    factory started is terminated at test teardown so leftover emulators
    cannot starve later tests.

    Pass `until` to return only once the guest has printed that marker, with
    the retry described at [`BOOT_ATTEMPTS`]. Callers own every later
    expectation, so a boot sequence stays asserted in its test.
    """
    booted: list[EmulatedDevice] = []

    def _start(flash: Path | None, admin_key: str | None) -> EmulatedDevice:
        if flash is None:
            flash = tmp_path / f"flash-{len(list(tmp_path.glob('flash-*.bin')))}.bin"
            shutil.copy(padded_image, flash)
        port = _free_port()
        # The signed firmware targets ESP32 chip revision 3.0 (ECO3), required by
        # the RSA signature scheme, so its bootloader refuses a lower revision.
        # QEMU's built-in eFuse default reports v0.0; pytest-embedded ships an
        # ECO3 (v3.0) default eFuse. Its qemu_efuse_path option would install that
        # eFuse but derefs `app.target`, which this raw-image harness has no App
        # for, so write the same eFuse and pass the drive directly. A fresh copy
        # per boot keeps the emulated hardware identity out of the flash under test.
        efuse = tmp_path / f"efuse-{len(list(tmp_path.glob('efuse-*.bin')))}.bin"
        efuse.write_bytes(QEMU_TARGETS["esp32"].default_efuse)
        dut = DutFactory.create(
            embedded_services="qemu",
            qemu_image_path=str(flash),
            skip_regenerate_image=True,
            qemu_extra_args=(
                f"-no-reboot -nic user,model=open_eth,hostfwd=tcp:127.0.0.1:{port}-:80"
                f" -drive file={efuse},if=none,format=raw,id=efuse"
                " -global driver=nvram.esp32.efuse,property=drive,value=efuse"
            ),
        )
        api = DeviceApi(base_url=f"http://127.0.0.1:{port}", admin_key=admin_key)
        device = EmulatedDevice(dut=dut, api=api, flash=flash)
        booted.append(device)
        return device

    def _boot(
        flash: Path | None = None,
        admin_key: str | None = None,
        until: str | None = None,
    ) -> EmulatedDevice:
        if until is None:
            return _start(flash, admin_key)
        for attempt in range(1, BOOT_ATTEMPTS):
            device = _start(flash, admin_key)
            try:
                device.dut.expect_exact(until, timeout=BOOT_TIMEOUT)
            except pexpect.TIMEOUT:
                device.dut.qemu.terminate()
                warnings.warn(f"emulated boot {attempt} never reached {until!r}; retrying", stacklevel=2)
            else:
                return device
        # The last attempt speaks for itself: its timeout is the failure.
        device = _start(flash, admin_key)
        device.dut.expect_exact(until, timeout=BOOT_TIMEOUT)
        return device

    yield _boot
    for device in booted:
        device.dut.qemu.terminate()


@pytest.fixture
def provisioned_device(boot_device: Callable[..., EmulatedDevice]) -> EmulatedDevice:
    """An emulated device commissioned with `ADMIN_KEY` and rebooted into
    provisioned mode. Its API carries the key; act as a stranger with
    `dataclasses.replace(device.api, admin_key=None)`."""
    setup_boot = boot_device(until="setup console started")
    ready = wait_for_api(setup_boot.api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail
    code, body = setup_boot.api.post_form(
        "/api/settings/wifi",
        {"ssid": "qemu-smoke-lab", "admin_secret": ADMIN_KEY},
    )
    assert code == 200, f"commissioning write returned HTTP {code}: {body[:200]!r}"
    setup_boot.dut.qemu.wait(timeout=60)

    device = boot_device(flash=setup_boot.flash, admin_key=ADMIN_KEY, until="StreamLine provisioned")
    ready = wait_for_api(device.api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail
    return device


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
        api = boot(until="setup console started").api
    ready = wait_for_api(api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail
    return api


@pytest.fixture
def authed_device_api(request: pytest.FixtureRequest, hardware_admin_key: str) -> DeviceApi:
    """The device under test as an authenticated client, on either target.

    Hardware target: the configured base URL plus the one-shot credential pipe
    (skips when that pipe is empty). QEMU target: a commissioned emulated device
    whose API already carries the throwaway `ADMIN_KEY`. Tests using this fixture
    drive the authenticated surface identically on both, so keep them
    non-destructive — reject paths and stateless checks, not persistent writes.
    """
    url = _hardware_url()
    if url is not None:
        if not hardware_admin_key:
            pytest.skip("hardware admin key is unavailable; cannot drive the authenticated API")
        api = DeviceApi(base_url=url, admin_key=hardware_admin_key)
    else:
        device: EmulatedDevice = request.getfixturevalue("provisioned_device")
        api = device.api
    ready = wait_for_api(api.fetch, API_TIMEOUT)
    assert ready.passed, ready.detail
    return api


@pytest.fixture(scope="session")
def hardware_admin_key() -> str:
    """Read the optional hardware credential once from the container pipe."""

    try:
        return read_secret_fd(os.environ, "STREAMLINE_ADMIN_KEY_FD")
    except ValueError as error:
        pytest.fail(str(error), pytrace=False)
