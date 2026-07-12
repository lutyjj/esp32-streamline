"""Sanity checks over a device boot transcript and the read-only device API.

Pure logic for the smoke harness: every function takes data (a transcript
string, an injected fetch callable) and returns `CheckResult` values, so the
contracts are unit-testable without QEMU, a serial port, or a network.
`smoke.py` owns collecting the inputs from a real or emulated device.
"""

import json
import re
from collections.abc import Callable
from dataclasses import dataclass

# Fragments that mark a failed boot in ESP-IDF and Rust output.
PANIC_MARKERS = (
    "Guru Meditation Error",
    "abort() was called",
    "assert failed:",
    "panicked at",
)

_ANSI_ESCAPES = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_BOARD_DESCRIPTOR = re.compile(r"using board descriptor '([^']+)'")
_APP_VERSION = re.compile(r"App version:\s+(\S+)")
# The ROM prints one `rst:0x..` banner per reset; more than one inside a
# single capture window means the firmware rebooted underneath the check.
_RESET_BANNER = re.compile(r"^rst:0x", re.MULTILINE)

# A fetch takes an API path such as "/api/status" and returns
# (HTTP status code, response body). Errors surface as raised OSError.
ApiFetch = Callable[[str], tuple[int, bytes]]


@dataclass(frozen=True)
class CheckResult:
    """Outcome of one named smoke check."""

    check: str
    passed: bool
    detail: str


def strip_ansi(text: str) -> str:
    """Remove ANSI color and cursor escapes that espflash adds to monitor output."""
    return _ANSI_ESCAPES.sub("", text)


def boot_checks(transcript: str) -> list[CheckResult]:
    """Verify one boot transcript: image loaded, app reached, no panic, no reboot.

    The transcript must cover exactly one intended boot, ending at the
    caller's frontier marker, so any panic or extra reset inside it is a
    genuine failure rather than expected later output.
    """
    plain = strip_ansi(transcript)
    results = [
        _presence(plain, "bootloader-loaded-app", "Loaded app from partition"),
        _presence(plain, "app-main-started", "Calling app_main()"),
        _extraction(plain, "board-descriptor-resolved", _BOARD_DESCRIPTOR, "board descriptor"),
        _extraction(plain, "firmware-version-reported", _APP_VERSION, "app version"),
        _no_panic(plain),
        _booted_once(plain),
    ]
    return results


def api_checks(fetch: ApiFetch) -> list[CheckResult]:
    """Verify the unauthenticated read surface of the device HTTP API."""
    return [
        _status_readable(fetch),
        _openapi_served(fetch),
    ]


def _presence(plain: str, check: str, marker: str) -> CheckResult:
    if marker in plain:
        return CheckResult(check, True, f"saw {marker!r}")
    return CheckResult(check, False, f"transcript never contained {marker!r}")


def _extraction(plain: str, check: str, pattern: re.Pattern[str], label: str) -> CheckResult:
    match = pattern.search(plain)
    if match is not None:
        return CheckResult(check, True, f"{label}: {match.group(1)}")
    return CheckResult(check, False, f"transcript never reported the {label}")


def _no_panic(plain: str) -> CheckResult:
    for line in plain.splitlines():
        for marker in PANIC_MARKERS:
            if marker in line:
                return CheckResult("no-panic", False, f"panic evidence: {line.strip()}")
    return CheckResult("no-panic", True, "no panic, abort, or failed assert in transcript")


def _booted_once(plain: str) -> CheckResult:
    resets = len(_RESET_BANNER.findall(plain))
    if resets <= 1:
        return CheckResult("booted-once", True, f"{resets} reset banner(s)")
    return CheckResult("booted-once", False, f"{resets} reset banners: the device rebooted during the check window")


def _status_readable(fetch: ApiFetch) -> CheckResult:
    check = "status-readable"
    try:
        code, body = fetch("/api/status")
    except OSError as error:
        return CheckResult(check, False, f"GET /api/status failed: {error}")
    if code != 200:
        return CheckResult(check, False, f"GET /api/status returned HTTP {code}")
    try:
        status = json.loads(body)
    except ValueError as error:
        return CheckResult(check, False, f"GET /api/status returned invalid JSON: {error}")
    if not isinstance(status, dict):
        return CheckResult(check, False, "GET /api/status returned a non-object JSON body")
    missing = [key for key in ("mode", "firmware_version") if not isinstance(status.get(key), str)]
    if missing:
        return CheckResult(check, False, f"status JSON lacks string field(s): {', '.join(missing)}")
    return CheckResult(check, True, f"mode={status['mode']} firmware_version={status['firmware_version']}")


def _openapi_served(fetch: ApiFetch) -> CheckResult:
    check = "openapi-served"
    try:
        code, body = fetch("/api/openapi.json")
    except OSError as error:
        return CheckResult(check, False, f"GET /api/openapi.json failed: {error}")
    if code != 200:
        return CheckResult(check, False, f"GET /api/openapi.json returned HTTP {code}")
    try:
        spec = json.loads(body)
    except ValueError as error:
        return CheckResult(check, False, f"GET /api/openapi.json returned invalid JSON: {error}")
    if not isinstance(spec, dict) or "openapi" not in spec:
        return CheckResult(check, False, "response is not an OpenAPI document")
    return CheckResult(check, True, f"OpenAPI {spec['openapi']} served by the device")
