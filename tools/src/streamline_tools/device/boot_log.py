"""Judge one captured boot transcript: markers, panics, resets.

Pure text analysis — `capture` collects the transcript, this module decides
what it proves. The boot-complete markers mirror log lines owned by
firmware/streamline/src/main.rs; renaming a line there must update them.
"""

import re

from streamline_tools.device.checks import CheckResult

# A real board resolves its mode as provisioned or as the setup AP.
DEVICE_BOOT_COMPLETE = ("StreamLine provisioned", "setup AP started:")

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
    return [
        _presence(plain, "bootloader-loaded-app", "Loaded app from partition"),
        _presence(plain, "app-main-started", "Calling app_main()"),
        _extraction(plain, "board-descriptor-resolved", _BOARD_DESCRIPTOR, "board descriptor"),
        _extraction(plain, "firmware-version-reported", _APP_VERSION, "app version"),
        _no_panic(plain),
        _booted_once(plain),
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
