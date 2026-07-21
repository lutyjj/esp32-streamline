from __future__ import annotations

import json
import os
import queue
import socket
import ssl
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from streamline_bridge.http import make_app
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceRegistry
from streamline_bridge.tcp import AuthenticatedConnection, CleartextAuthenticator
from streamline_bridge.transport import (
    CONTRACT_VERSION,
    DEFAULT_PORT,
    KEY_ID_PATTERN_TEXT,
    MAX_KEYS,
    PSK_BYTES,
    TLS_CIPHER,
    TLS_IDENTITY_PREFIX,
    TLS_KEY_EXCHANGE,
    TLS_VERSION,
    TlsPskAuthenticator,
    TransportControl,
    TransportStateError,
    TransportStateStore,
    parse_identity,
)


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


def tls_attempt(
    authenticator: TlsPskAuthenticator,
    identity: str,
    psk: bytes,
    maximum_version: ssl.TLSVersion = ssl.TLSVersion.TLSv1_3,
) -> tuple[BaseException | None, AuthenticatedConnection | BaseException]:
    server_socket, client_socket = socket.socketpair()
    server_socket.settimeout(2)
    client_socket.settimeout(2)
    result: queue.Queue[AuthenticatedConnection | BaseException] = queue.Queue(maxsize=1)

    def authenticate() -> None:
        try:
            result.put(authenticator.authenticate(server_socket, ("192.0.2.10", 39000)))
        except BaseException as exc:
            result.put(exc)

    worker = threading.Thread(target=authenticate)
    worker.start()
    client_error: BaseException | None = None
    stream: ssl.SSLSocket | None = None
    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        context.minimum_version = maximum_version
        context.maximum_version = maximum_version
        context.set_psk_client_callback(lambda _hint: (identity, psk))
        stream = context.wrap_socket(client_socket, server_hostname="bridge")
    except BaseException as exc:
        client_error = exc
        client_socket.close()
    worker.join(timeout=3)
    if worker.is_alive():
        raise AssertionError("TLS authentication did not finish")
    server_result = result.get_nowait()
    if stream is not None:
        stream.close()
    if isinstance(server_result, AuthenticatedConnection):
        server_result.socket.close()
    return client_error, server_result


class TransportStateStoreTests(unittest.TestCase):
    key_id = "eli1-00112233445566778899aabbccddeeff"
    psk = "ab" * 32

    def test_key_file_round_trips_atomically_with_private_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transport.json"
            store = TransportStateStore(path, maximum=2)

            store.put(self.key_id, self.psk)

            self.assertEqual(TransportStateStore(path).get(self.key_id), bytes.fromhex(self.psk))
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            self.assertNotIn(self.psk, repr(store))

    def test_invalid_unknown_and_over_limit_mutations_leave_the_file_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transport.json"
            store = TransportStateStore(path, maximum=1)
            store.put(self.key_id, self.psk)
            before = path.read_bytes()

            with self.assertRaises(TransportStateError):
                store.put("eli1-ffeeddccbbaa99887766554433221100", "cd" * 32)
            with self.assertRaises(TransportStateError):
                store.delete("eli1-ffeeddccbbaa99887766554433221100")
            with self.assertRaises(TransportStateError):
                store.put(self.key_id, "not-a-key")

            self.assertEqual(path.read_bytes(), before)

    def test_invalid_version_and_symlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            invalid = root / "invalid.json"
            invalid.write_text('{"version":2,"keys":{}}', encoding="utf-8")
            with self.assertRaises(TransportStateError):
                TransportStateStore(invalid)

            non_boolean_mode = root / "non-boolean.json"
            non_boolean_mode.write_text('{"version":1,"tls_enabled":"yes","keys":{}}', encoding="utf-8")
            with self.assertRaises(TransportStateError):
                TransportStateStore(non_boolean_mode)

            link = root / "link.json"
            link.symlink_to(invalid)
            with self.assertRaises(OSError):
                TransportStateStore(link)

    def test_listener_mode_persists_with_the_keys_and_partial_shapes_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "transport.json"
            store = TransportStateStore(path)
            store.put(self.key_id, self.psk)

            store.set_tls_enabled(True)

            reopened = TransportStateStore(path)
            self.assertTrue(reopened.tls_enabled)
            self.assertEqual(reopened.get(self.key_id), bytes.fromhex(self.psk))

            keys_only = Path(temporary) / "keys-only.json"
            keys_only.write_text(json.dumps({"version": 1, "keys": {self.key_id: self.psk}}), encoding="utf-8")
            with self.assertRaises(TransportStateError):
                TransportStateStore(keys_only)


class TransportControlTests(unittest.TestCase):
    def test_mode_switch_persists_selects_the_authenticator_and_drops_producers(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            store = TransportStateStore(path)
            authenticator = TlsPskAuthenticator(store)
            control = TransportControl(store, authenticator, port=39000)
            drops: list[str | None] = []
            control.bind_producer_disconnect(drops.append)

            self.assertIsInstance(control.producer_authenticator(), CleartextAuthenticator)
            self.assertEqual(control.snapshot()["mode"], "cleartext")

            control.set_tls_enabled(True)
            self.assertIs(control.producer_authenticator(), authenticator)
            self.assertEqual(control.snapshot()["mode"], "tls-psk")
            self.assertEqual(drops, [None], "a mode switch drops every producer")
            self.assertTrue(TransportStateStore(path).tls_enabled)

            control.set_tls_enabled(True)
            self.assertEqual(drops, [None])

            control.set_tls_enabled(False)
            self.assertIsInstance(control.producer_authenticator(), CleartextAuthenticator)
            self.assertEqual(drops, [None, None])

    def test_key_mutations_persist_first_and_revoke_only_that_key(self) -> None:
        key_id = "eli1-00112233445566778899aabbccddeeff"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            store = TransportStateStore(path)
            control = TransportControl(store, TlsPskAuthenticator(store), port=39000)
            drops: list[str | None] = []
            control.bind_producer_disconnect(drops.append)

            control.put_key(key_id, "ab" * 32)
            self.assertEqual(drops, [], "a first provisioning has no session to revoke")
            self.assertEqual(TransportStateStore(path).ids(), (key_id,))

            control.put_key(key_id, "cd" * 32)
            self.assertEqual(drops, [key_id], "a replacement revokes exactly that key's sessions")

            control.delete_key(key_id)
            self.assertEqual(drops, [key_id, key_id])
            self.assertEqual(TransportStateStore(path).ids(), ())

            with self.assertRaises(TransportStateError):
                control.delete_key(key_id)
            self.assertEqual(drops, [key_id, key_id], "a failed mutation revokes nothing")

    def test_a_failed_persist_leaves_keys_and_sessions_unchanged(self) -> None:
        key_id = "eli1-00112233445566778899aabbccddeeff"
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "state.json"
            store = TransportStateStore(path)
            store.put(key_id, "ab" * 32)
            control = TransportControl(store, TlsPskAuthenticator(store), port=39000)
            drops: list[str | None] = []
            control.bind_producer_disconnect(drops.append)

            with (
                patch.object(TransportStateStore, "_write", side_effect=OSError("disk full")),
                self.assertRaises(OSError),
            ):
                control.put_key(key_id, "cd" * 32)
            self.assertEqual(drops, [], "an unpersisted replacement must not drop sessions")
            self.assertEqual(store.get(key_id), bytes.fromhex("ab" * 32))

            with (
                patch.object(TransportStateStore, "_write", side_effect=OSError("disk full")),
                self.assertRaises(OSError),
            ):
                control.delete_key(key_id)
            self.assertEqual(drops, [])
            self.assertEqual(store.ids(), (key_id,))

    def test_unconfigured_control_stays_cleartext_and_refuses_mode_changes(self) -> None:
        control = TransportControl(None, None, port=39000)

        self.assertFalse(control.configurable)
        self.assertFalse(control.snapshot()["configurable"])
        self.assertEqual(control.snapshot()["mode"], "cleartext")
        self.assertIsInstance(control.producer_authenticator(), CleartextAuthenticator)
        with self.assertRaises(TransportStateError):
            control.set_tls_enabled(True)
        with self.assertRaises(TransportStateError):
            control.put_key("eli1-00112233445566778899aabbccddeeff", "ab" * 32)
        with self.assertRaises(TransportStateError):
            control.delete_key("eli1-00112233445566778899aabbccddeeff")


class TransportAuthenticationTests(unittest.TestCase):
    key_id = "eli1-00112233445566778899aabbccddeeff"
    psk = "ab" * 32
    token = "transport-test-token"

    def test_implementation_matches_the_machine_readable_transport_contract(self) -> None:
        contract = json.loads(Path("/repo/docs/pcm-transport.json").read_text(encoding="utf-8"))

        self.assertEqual(contract["contract_version"], CONTRACT_VERSION)
        self.assertEqual(contract["modes"], ["cleartext", "tls-psk"])
        self.assertEqual(contract["port"], DEFAULT_PORT)
        self.assertEqual(contract["identity_prefix"], TLS_IDENTITY_PREFIX)
        self.assertEqual(contract["key_id_pattern"], KEY_ID_PATTERN_TEXT)
        self.assertEqual(contract["psk_bytes"], PSK_BYTES)
        self.assertEqual(contract["tls_version"], TLS_VERSION)
        self.assertEqual(contract["tls_cipher"], TLS_CIPHER)
        self.assertEqual(contract["tls_key_exchange"], TLS_KEY_EXCHANGE)
        self.assertEqual(MAX_KEYS, 64)

    def test_identity_contract_rejects_unknown_versions_and_shapes(self) -> None:
        self.assertEqual(parse_identity(f"eli1:1:{self.key_id}"), self.key_id)
        self.assertIsNone(parse_identity(f"eli1:2:{self.key_id}"))
        self.assertIsNone(parse_identity("eli1:1:not-a-key"))
        self.assertIsNone(parse_identity(None))

    def test_non_exact_cipher_wrong_unknown_and_downgrade_clients_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            keys = TransportStateStore(Path(temporary) / "keys.json")
            keys.put(self.key_id, self.psk)
            authenticator = TlsPskAuthenticator(keys)
            identity = f"eli1:1:{self.key_id}"

            self.assertEqual(authenticator._lookup_psk(identity), bytes.fromhex(self.psk))
            self.assertEqual(authenticator._local.key_id, self.key_id)

            client_error, non_exact_cipher = tls_attempt(authenticator, identity, bytes.fromhex(self.psk))
            self.assertIsNone(client_error)
            self.assertNotIsInstance(non_exact_cipher, AuthenticatedConnection)

            wrong = tls_attempt(authenticator, identity, bytes.fromhex("cd" * 32))
            unknown = tls_attempt(
                authenticator,
                "eli1:1:eli1-ffeeddccbbaa99887766554433221100",
                bytes.fromhex(self.psk),
            )
            downgrade = tls_attempt(
                authenticator,
                identity,
                bytes.fromhex(self.psk),
                ssl.TLSVersion.TLSv1_2,
            )

            for client_failure, server_failure in (wrong, unknown, downgrade):
                self.assertIsNotNone(client_failure)
                self.assertNotIsInstance(server_failure, AuthenticatedConnection)

            self.assertEqual(authenticator.snapshot(), (0, 4))

    def test_cleartext_bytes_fail_before_authentication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            authenticator = TlsPskAuthenticator(TransportStateStore(Path(temporary) / "keys.json"))
            server_socket, client_socket = socket.socketpair()
            server_socket.settimeout(1)
            result: queue.Queue[BaseException | None] = queue.Queue(maxsize=1)

            def authenticate() -> None:
                try:
                    authenticator.authenticate(server_socket, ("192.0.2.10", 39000))
                except BaseException as exc:
                    result.put(exc)
                else:
                    result.put(None)

            worker = threading.Thread(target=authenticate)
            worker.start()
            client_socket.sendall(b"ELI1 cleartext is not TLS")
            client_socket.shutdown(socket.SHUT_WR)
            worker.join(timeout=2)
            client_socket.close()

            self.assertFalse(worker.is_alive())
            self.assertIsNotNone(result.get_nowait())
            self.assertEqual(authenticator.snapshot(), (0, 1))

    def test_concurrent_psk_callbacks_keep_each_thread_local_identity(self) -> None:
        second_id = "eli1-ffeeddccbbaa99887766554433221100"
        second_psk = "cd" * 32
        with tempfile.TemporaryDirectory() as temporary:
            keys = TransportStateStore(Path(temporary) / "keys.json")
            keys.put(self.key_id, self.psk)
            keys.put(second_id, second_psk)
            authenticator = TlsPskAuthenticator(keys)
            accepted: queue.Queue[str] = queue.Queue()
            barrier = threading.Barrier(4)

            def connect(key_id: str, psk: str) -> None:
                self.assertEqual(authenticator._lookup_psk(f"eli1:1:{key_id}"), bytes.fromhex(psk))
                barrier.wait(timeout=2)
                accepted.put(authenticator._local.key_id)

            workers = [
                threading.Thread(target=connect, args=(key_id, psk))
                for key_id, psk in ((self.key_id, self.psk), (second_id, second_psk))
                for _ in range(2)
            ]
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=4)

            self.assertTrue(all(not worker.is_alive() for worker in workers))
            self.assertEqual(
                sorted(accepted.get_nowait() for _ in workers),
                sorted([self.key_id, self.key_id, second_id, second_id]),
            )

    def test_key_api_is_authenticated_and_never_reads_psks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            keys = TransportStateStore(Path(temporary) / "keys.json")
            authenticator = TlsPskAuthenticator(keys)
            control = TransportControl(keys, authenticator, port=39000)
            client = TestClient(
                make_app(SourceRegistry(make_pipeline, 2), "test", api_token=self.token, transport=control)
            )
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
