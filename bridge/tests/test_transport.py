from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from streamline_bridge.http import make_app
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceRegistry
from streamline_bridge.transport import (
    TlsPskAuthenticator,
    TransportControl,
    TransportKeyError,
    TransportKeyStore,
    parse_identity,
)


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


class TransportKeyStoreTests(unittest.TestCase):
    key_id = "eli1-00112233445566778899aabbccddeeff"
    psk = "ab" * 32

    def test_key_file_round_trips_atomically_with_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transport-keys.json"
            store = TransportKeyStore(path, maximum=2)

            store.put(self.key_id, self.psk)

            self.assertEqual(TransportKeyStore(path).get(self.key_id), bytes.fromhex(self.psk))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertNotIn(self.psk, repr(store))

    def test_invalid_unknown_and_over_limit_mutations_leave_the_file_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transport-keys.json"
            store = TransportKeyStore(path, maximum=1)
            store.put(self.key_id, self.psk)
            before = path.read_bytes()

            with self.assertRaises(TransportKeyError):
                store.put("eli1-ffeeddccbbaa99887766554433221100", "cd" * 32)
            with self.assertRaises(TransportKeyError):
                store.delete("eli1-ffeeddccbbaa99887766554433221100")
            with self.assertRaises(TransportKeyError):
                store.put(self.key_id, "not-a-key")

            self.assertEqual(path.read_bytes(), before)

    def test_invalid_version_and_symlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            invalid = root / "invalid.json"
            invalid.write_text('{"version":2,"keys":{}}', encoding="utf-8")
            with self.assertRaises(TransportKeyError):
                TransportKeyStore(invalid)

            link = root / "link.json"
            link.symlink_to(invalid)
            with self.assertRaises(OSError):
                TransportKeyStore(link)


class TransportAuthenticationTests(unittest.TestCase):
    key_id = "eli1-00112233445566778899aabbccddeeff"
    psk = "ab" * 32
    token = "transport-test-token"

    def test_identity_contract_rejects_unknown_versions_and_shapes(self) -> None:
        self.assertEqual(parse_identity(f"eli1:1:{self.key_id}"), self.key_id)
        self.assertIsNone(parse_identity(f"eli1:2:{self.key_id}"))
        self.assertIsNone(parse_identity("eli1:1:not-a-key"))
        self.assertIsNone(parse_identity(None))

    def test_key_api_is_authenticated_and_never_reads_psks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            keys = TransportKeyStore(Path(temporary) / "keys.json")
            authenticator = TlsPskAuthenticator(keys)
            control = TransportControl(
                keys,
                authenticator,
                self.token,
                cleartext_enabled=True,
                tls_enabled=True,
                cleartext_port=39000,
                tls_port=39001,
            )
            client = TestClient(make_app(SourceRegistry(make_pipeline, 2), "test", transport=control))
            path = f"/api/transport/keys/{self.key_id}"

            missing = client.put(path, json={"psk": self.psk})
            provisioned = client.put(path, headers=self.headers, json={"psk": self.psk})
            status = client.get("/api/transport")
            deleted = client.delete(path, headers=self.headers)

            self.assertEqual(missing.status_code, 401)
            self.assertEqual(provisioned.status_code, 201)
            self.assertEqual(status.json()["key_ids"], [self.key_id])
            self.assertNotIn(self.psk, status.text)
            self.assertEqual(deleted.json(), {"deleted": self.key_id})

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}
