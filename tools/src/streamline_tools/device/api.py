"""The device HTTP surface: transport, readiness polling, and contract checks.

`DeviceApi` is the one client both the smoke CLI and the pytest suite use,
for hardware and emulated devices alike. Checks return `CheckResult` values
and take the fetch callable, so they are unit-testable without a device.
"""

import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field

from streamline_tools.device.checks import CheckResult

# A fetch takes an API path such as "/api/status" and returns
# (HTTP status code, response body). Errors surface as raised OSError.
ApiFetch = Callable[[str], tuple[int, bytes]]

_HTTP_TIMEOUT = 10.0
_POLL_INTERVAL = 2.0


@dataclass(frozen=True)
class DeviceApi:
    """One device's HTTP surface, addressed by its base URL."""

    base_url: str
    admin_key: str | None = field(default=None, repr=False)

    def fetch(self, path: str) -> tuple[int, bytes]:
        return self._exchange(urllib.request.Request(self.base_url + path))

    def post_form(self, path: str, fields: dict[str, str]) -> tuple[int, bytes]:
        request = urllib.request.Request(
            self.base_url + path,
            data=urllib.parse.urlencode(fields).encode(),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        return self._exchange(request)

    def _exchange(self, request: urllib.request.Request) -> tuple[int, bytes]:
        if self.admin_key:
            request.add_header("Authorization", f"Bearer {self.admin_key}")
        # The device stores its embedded assets gzipped and serves them with
        # Content-Encoding: gzip (docs/design.md "HTTP API Shape"); urllib
        # does not decode transfer encodings, so this client honors the one
        # the device uses.
        request.add_header("Accept-Encoding", "gzip")
        try:
            with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT) as response:
                return response.status, _decoded(response.headers.get("Content-Encoding"), response.read())
        except urllib.error.HTTPError as error:
            return error.code, _decoded(error.headers.get("Content-Encoding"), error.read())


def _decoded(content_encoding: str | None, body: bytes) -> bytes:
    if content_encoding == "gzip":
        return gzip.decompress(body)
    return body


def wait_for_api(fetch: ApiFetch, timeout: float) -> CheckResult:
    """Poll the status endpoint until the booting device serves HTTP."""
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
        time.sleep(_POLL_INTERVAL)
    return CheckResult("api-reachable", False, f"no healthy response within {timeout:.0f}s: {last_error}")


def api_checks(fetch: ApiFetch) -> list[CheckResult]:
    """Verify the unauthenticated read surface of the device HTTP API."""
    return [
        _status_readable(fetch),
        _openapi_served(fetch),
    ]


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
