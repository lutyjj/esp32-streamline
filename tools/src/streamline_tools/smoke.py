#!/usr/bin/env python3
"""Boot and API smoke runner for QEMU-emulated and USB-connected devices.

`streamline-smoke qemu` boots a merged flash image (`streamline-*-full.bin`)
in Espressif's QEMU and verifies the transcript up to the emulation frontier:
QEMU emulates no Wi-Fi PHY, so a StreamLine boot is provable only up to
board-descriptor resolution before `esp_phy_enable` aborts. `streamline-smoke
device` resets the USB-connected board over serial, verifies the same
transcript through Wi-Fi mode resolution, then exercises the read-only HTTP
API. Stdlib-only so the system `python3` can run the device flow on the host,
where the serial port lives.
"""

import argparse
import dataclasses
import json
import queue
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path

from streamline_tools.smoke_checks import CheckResult, api_checks, boot_checks, strip_ansi

# Boot-complete markers mirror log lines owned by firmware/streamline/src/main.rs
# and the ESP-IDF Wi-Fi bring-up; renaming a line there must update this table.
# QEMU stops at the board descriptor because the Wi-Fi PHY assert is the known
# emulation frontier; a real board must resolve its mode (provisioned or setup).
QEMU_BOOT_COMPLETE = ("using board descriptor '",)
DEVICE_BOOT_COMPLETE = ("StreamLine provisioned", "setup AP started:")

# The ESP32 bootloader sits at 0x1000 in a merged flash image; its image
# header declares the flash size the partition table was laid out for, and
# QEMU rejects every size but these. Padding to anything smaller than the
# declared size boots the bootloader but fails the app's flash-chip probe.
_BOOTLOADER_OFFSET = 0x1000
_IMAGE_MAGIC = 0xE9
_FLASH_SIZE_MEGABYTES = {0x1: 2, 0x2: 4, 0x3: 8, 0x4: 16}
_ERASED_FLASH_BYTE = b"\xff"

_QEMU_BOOT_TIMEOUT = 60.0
# Worst case before a real board resolves its mode: three Wi-Fi attempts of up
# to ~30 s each (connect plus netif timeouts), then the setup-AP fallback.
_DEVICE_BOOT_TIMEOUT = 150.0
_API_READY_TIMEOUT = 60.0
_API_POLL_INTERVAL = 2.0
_HTTP_TIMEOUT = 5.0
_TRANSCRIPT_TAIL_LINES = 40


def pad_flash_image(image: bytes) -> bytes:
    """Pad a merged flash image with erased-flash bytes to its declared flash size."""
    header = image[_BOOTLOADER_OFFSET : _BOOTLOADER_OFFSET + 4]
    if len(header) < 4 or header[0] != _IMAGE_MAGIC:
        raise ValueError("not a merged flash image: no bootloader at offset 0x1000 (need streamline-*-full.bin)")
    size_field = header[3] >> 4
    megabytes = _FLASH_SIZE_MEGABYTES.get(size_field)
    if megabytes is None:
        raise ValueError(f"image declares flash size field {size_field:#x}, which QEMU cannot emulate")
    size = megabytes * 1024 * 1024
    if len(image) > size:
        raise ValueError(f"flash image is {len(image)} bytes but declares a {megabytes} MiB flash")
    return image + _ERASED_FLASH_BYTE * (size - len(image))


def read_until(readline: Callable[[], str], markers: Sequence[str], timeout: float) -> tuple[str, str | None]:
    """Collect lines until one contains a marker, EOF, or the timeout expires.

    `readline` may block indefinitely on a silent device, so a daemon thread
    feeds a queue and the deadline is enforced on the queue reads. Returns the
    transcript up to and including the marker line, and the matched marker
    (`None` on EOF or timeout).
    """
    lines: queue.Queue[str | None] = queue.Queue()

    def _reader() -> None:
        try:
            while True:
                line = readline()
                if line == "":
                    break
                lines.put(line)
        finally:
            lines.put(None)

    threading.Thread(target=_reader, daemon=True).start()
    deadline = time.monotonic() + timeout
    collected: list[str] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "".join(collected), None
        try:
            line = lines.get(timeout=remaining)
        except queue.Empty:
            return "".join(collected), None
        if line is None:
            return "".join(collected), None
        collected.append(line)
        plain = strip_ansi(line)
        for marker in markers:
            if marker in plain:
                return "".join(collected), marker


def _pump_process(command: Sequence[str], markers: Sequence[str], timeout: float) -> tuple[str, str | None]:
    """Run a serial-emitting process and read its output until a boot marker."""
    process = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    assert process.stdout is not None
    try:
        return read_until(process.stdout.readline, markers, timeout)
    finally:
        process.kill()
        process.wait()


def qemu_boot(flash_image: Path, qemu_binary: str, timeout: float) -> tuple[str, str | None]:
    """Boot a merged flash image in QEMU and capture serial output to the frontier.

    `-no-reboot` turns the reboot-after-panic into a QEMU exit, so a panicking
    image fails fast with the panic in the transcript instead of looping until
    the timeout.
    """
    padded = pad_flash_image(flash_image.read_bytes())
    with tempfile.NamedTemporaryFile(suffix=".bin") as flash:
        flash.write(padded)
        flash.flush()
        command = (
            qemu_binary,
            "-machine",
            "esp32",
            "-nographic",
            "-no-reboot",
            "-drive",
            f"file={flash.name},if=mtd,format=raw",
        )
        return _pump_process(command, QEMU_BOOT_COMPLETE, timeout)


def serial_boot(port: str, timeout: float) -> tuple[str, str | None]:
    """Reset the USB-connected board and capture one boot over serial.

    Opening this serial adapter always resets the board; espflash owns the
    reset handshake and panic decoding, exactly like `make firmware-capture`.
    """
    command = ("espflash", "monitor", "--non-interactive", "--chip", "esp32", "--port", port)
    return _pump_process(command, DEVICE_BOOT_COMPLETE, timeout)


def http_fetch(base_url: str, path: str) -> tuple[int, bytes]:
    """Fetch an API path; HTTP error statuses are results, not exceptions."""
    request = urllib.request.Request(base_url.rstrip("/") + path)
    try:
        with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def wait_for_api(fetch: Callable[[str], tuple[int, bytes]], timeout: float) -> CheckResult:
    """Poll the status endpoint until the rebooted device serves HTTP again."""
    deadline = time.monotonic() + timeout
    last_error = "no response"
    while time.monotonic() < deadline:
        try:
            code, _ = fetch("/api/status")
        except OSError as error:
            last_error = str(error)
        else:
            if code == 200:
                return CheckResult("api-reachable", True, "device answered GET /api/status")
            last_error = f"HTTP {code}"
        time.sleep(_API_POLL_INTERVAL)
    return CheckResult("api-reachable", False, f"no healthy response within {timeout:.0f}s: {last_error}")


def _boot_completed(matched: str | None, timeout: float) -> CheckResult:
    if matched is not None:
        return CheckResult("boot-completed", True, f"reached {matched!r}")
    return CheckResult("boot-completed", False, f"no boot-complete marker within {timeout:.0f}s")


def run_qemu(flash_image: Path, qemu_binary: str, timeout: float) -> tuple[list[CheckResult], str]:
    transcript, matched = qemu_boot(flash_image, qemu_binary, timeout)
    return [_boot_completed(matched, timeout), *boot_checks(transcript)], transcript


def run_device(port: str, url: str | None, boot_timeout: float, api_timeout: float) -> tuple[list[CheckResult], str]:
    transcript, matched = serial_boot(port, boot_timeout)
    results = [_boot_completed(matched, boot_timeout), *boot_checks(transcript)]
    if url is not None:

        def fetch(path: str) -> tuple[int, bytes]:
            return http_fetch(url, path)

        ready = wait_for_api(fetch, api_timeout)
        results.append(ready)
        if ready.passed:
            results.extend(api_checks(fetch))
    return results, transcript


def report(results: Sequence[CheckResult], transcript: str, as_json: bool) -> int:
    """Print the outcome and return the process exit code."""
    failed = [result for result in results if not result.passed]
    if as_json:
        payload = {"passed": not failed, "checks": [dataclasses.asdict(result) for result in results]}
        print(json.dumps(payload, indent=2))
    else:
        for result in results:
            print(f"{'PASS' if result.passed else 'FAIL'} {result.check}: {result.detail}")
        print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    if failed and transcript:
        tail = strip_ansi(transcript).splitlines()[-_TRANSCRIPT_TAIL_LINES:]
        print("--- transcript tail ---", file=sys.stderr)
        for line in tail:
            print(line, file=sys.stderr)
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="streamline-smoke", description=__doc__)
    parser.add_argument("--json", action="store_true", help="print a JSON report instead of text")
    commands = parser.add_subparsers(dest="command", required=True)

    qemu = commands.add_parser("qemu", help="boot a merged flash image in QEMU and check the transcript")
    qemu.add_argument("--flash-image", type=Path, required=True, help="merged image (streamline-*-full.bin)")
    qemu.add_argument("--qemu", default="qemu-system-xtensa", help="QEMU binary (Espressif fork)")
    qemu.add_argument("--boot-timeout", type=float, default=_QEMU_BOOT_TIMEOUT)

    device = commands.add_parser("device", help="reset the USB-connected board, check boot, then the HTTP API")
    device.add_argument("--port", required=True, help="serial port, e.g. /dev/cu.usbserial-0001")
    device.add_argument("--url", help="device base URL for API checks, e.g. http://192.0.2.10")
    device.add_argument("--boot-timeout", type=float, default=_DEVICE_BOOT_TIMEOUT)
    device.add_argument("--api-timeout", type=float, default=_API_READY_TIMEOUT)

    args = parser.parse_args()
    try:
        if args.command == "qemu":
            results, transcript = run_qemu(args.flash_image, args.qemu, args.boot_timeout)
        else:
            results, transcript = run_device(args.port, args.url, args.boot_timeout, args.api_timeout)
    except FileNotFoundError as error:
        print(f"missing prerequisite: {error}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    return report(results, transcript, args.json)


if __name__ == "__main__":
    sys.exit(main())
