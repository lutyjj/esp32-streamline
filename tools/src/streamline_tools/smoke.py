#!/usr/bin/env python3
"""Boot and API smoke for the USB-connected device (`streamline-smoke`).

Resets the board over serial, judges the boot transcript through Wi-Fi mode
resolution, then exercises the read-only HTTP API. A thin CLI over the
`streamline_tools.device` library; the emulated-device suite in `tools/smoke/`
consumes the same library through pytest.
"""

import argparse
import dataclasses
import json
import sys
from collections.abc import Sequence

from streamline_tools.device.api import DeviceApi, api_checks, wait_for_api
from streamline_tools.device.boot_log import DEVICE_BOOT_COMPLETE, boot_checks, strip_ansi
from streamline_tools.device.capture import serial_boot
from streamline_tools.device.checks import CheckResult

# Worst case before a real board resolves its mode: three Wi-Fi attempts of up
# to ~30 s each (connect plus netif timeouts), then the setup-AP fallback.
_BOOT_TIMEOUT = 150.0
_API_TIMEOUT = 60.0
_TRANSCRIPT_TAIL_LINES = 40


def run_device(port: str, url: str | None, boot_timeout: float, api_timeout: float) -> tuple[list[CheckResult], str]:
    transcript, matched = serial_boot(port, DEVICE_BOOT_COMPLETE, boot_timeout)
    completed = (
        CheckResult("boot-completed", True, f"reached {matched!r}")
        if matched is not None
        else CheckResult("boot-completed", False, f"no boot-complete marker within {boot_timeout:.0f}s")
    )
    results = [completed, *boot_checks(transcript)]
    if url is not None:
        api = DeviceApi(base_url=url)
        ready = wait_for_api(api.fetch, api_timeout)
        results.append(ready)
        if ready.passed:
            results.extend(api_checks(api.fetch))
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

    device = commands.add_parser("device", help="reset the USB-connected board, check boot, then the HTTP API")
    device.add_argument("--port", required=True, help="serial port, e.g. /dev/cu.usbserial-0001")
    device.add_argument("--url", help="device base URL for API checks, e.g. http://192.0.2.10")
    device.add_argument("--boot-timeout", type=float, default=_BOOT_TIMEOUT)
    device.add_argument("--api-timeout", type=float, default=_API_TIMEOUT)

    args = parser.parse_args()
    try:
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
