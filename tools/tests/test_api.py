"""Contract tests for the device API checks and readiness polling."""

import gzip
import json
import unittest

from streamline_tools.device.api import DeviceApi, _decoded, api_checks, wait_for_api
from streamline_tools.device.checks import CheckResult


def result(results: list[CheckResult], check: str) -> CheckResult:
    matches = [item for item in results if item.check == check]
    assert len(matches) == 1, f"expected exactly one {check!r} result"
    return matches[0]


class ApiChecksTest(unittest.TestCase):
    def test_client_repr_never_includes_its_admin_key(self) -> None:
        client = DeviceApi(base_url="http://192.0.2.1", admin_key="private-fixture-key")
        self.assertNotIn("private-fixture-key", repr(client))

    def test_healthy_api_passes(self) -> None:
        bodies = {
            "/api/status": json.dumps({"mode": "provisioned", "firmware_version": "0.5.5"}),
            "/api/openapi.json": json.dumps({"openapi": "3.1.0"}),
        }
        results = api_checks(lambda path: (200, bodies[path].encode()))
        self.assertTrue(all(item.passed for item in results), results)
        self.assertIn("mode=provisioned", result(results, "status-readable").detail)

    def test_http_error_status_fails(self) -> None:
        results = api_checks(lambda path: (503, b""))
        self.assertFalse(result(results, "status-readable").passed)
        self.assertIn("503", result(results, "status-readable").detail)

    def test_invalid_json_fails(self) -> None:
        results = api_checks(lambda path: (200, b"<html>not json</html>"))
        self.assertFalse(result(results, "status-readable").passed)

    def test_missing_status_fields_fail(self) -> None:
        results = api_checks(lambda path: (200, json.dumps({"openapi": "3.1.0", "mode": "provisioned"}).encode()))
        item = result(results, "status-readable")
        self.assertFalse(item.passed)
        self.assertIn("firmware_version", item.detail)

    def test_connection_error_fails_instead_of_raising(self) -> None:
        def fetch(path: str) -> tuple[int, bytes]:
            raise OSError("connection refused")

        results = api_checks(fetch)
        self.assertFalse(result(results, "status-readable").passed)
        self.assertIn("connection refused", result(results, "status-readable").detail)


class TransportDecodingTest(unittest.TestCase):
    """The device serves its embedded assets gzip-encoded; the client decodes."""

    def test_gzip_encoded_bodies_are_decompressed(self) -> None:
        body = b'{"openapi": "3.1.0"}'
        self.assertEqual(_decoded("gzip", gzip.compress(body)), body)

    def test_identity_bodies_pass_through(self) -> None:
        self.assertEqual(_decoded(None, b"plain"), b"plain")


class WaitForApiTest(unittest.TestCase):
    def test_immediate_success_passes(self) -> None:
        item = wait_for_api(lambda path: (200, b"{}"), timeout=5.0)
        self.assertTrue(item.passed)

    def test_never_reachable_fails_with_last_error(self) -> None:
        def fetch(path: str) -> tuple[int, bytes]:
            raise OSError("connection refused")

        item = wait_for_api(fetch, timeout=0.0)
        self.assertFalse(item.passed)
        self.assertIn("no response", item.detail)


if __name__ == "__main__":
    unittest.main()
