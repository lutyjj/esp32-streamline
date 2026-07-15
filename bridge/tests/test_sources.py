from __future__ import annotations

import socket
import unittest
from http import HTTPStatus
from typing import cast

from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import Source, SourceAdmissionError, SourceRegistry, SourceSelectionError


class FakeTime:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


class SourceRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.time = FakeTime()

    def registry(self, max_sources: int = 2, allowed: frozenset[str] = frozenset()) -> SourceRegistry[AudioPipeline]:
        return SourceRegistry(make_pipeline, max_sources, allowed, eviction_idle_seconds=10.0, now=self.time)

    def disconnect(
        self,
        registry: SourceRegistry[AudioPipeline],
        key: str,
        *,
        peer_ip: str | None = None,
        transport: str = "cleartext",
    ) -> Source[AudioPipeline]:
        server, peer = socket.socketpair()
        try:
            lease = registry.lease_producer(key, server, peer_ip=peer_ip, transport=transport)
            lease.close()
            return lease.source
        finally:
            peer.close()
            server.close()

    @staticmethod
    def lifecycle(snapshot: dict[str, object]) -> dict[str, object]:
        return cast("dict[str, object]", snapshot["lifecycle"])

    def test_bare_stream_lease_is_adopted_atomically_by_the_first_producer(self) -> None:
        registry = self.registry()
        http = registry.lease_http(None)
        server, peer = socket.socketpair()
        try:
            producer = registry.lease_producer("192.0.2.10", server)

            self.assertIs(producer.hub, http.hub)
            self.assertEqual(registry.snapshot().keys(), {"192.0.2.10"})
        finally:
            producer.close()
            http.close()
            peer.close()
            server.close()

    def test_reconnect_before_expiry_preserves_pipeline(self) -> None:
        registry = self.registry()
        first = self.disconnect(registry, "192.0.2.10")
        self.time.advance(9.0)

        server, peer = socket.socketpair()
        try:
            lease = registry.lease_producer("192.0.2.10", server)
            self.assertIs(lease.source, first)
        finally:
            lease.close()
            peer.close()
            server.close()

    def test_disconnected_dynamic_source_is_evicted_and_admission_recovers_after_ip_churn(self) -> None:
        registry = self.registry(max_sources=2)
        self.disconnect(registry, "192.0.2.10")
        self.disconnect(registry, "192.0.2.11")
        with self.assertRaises(SourceAdmissionError):
            self.disconnect(registry, "192.0.2.12")
        self.time.advance(10.0)

        admitted = self.disconnect(registry, "192.0.2.12")

        self.assertEqual(admitted.key, "192.0.2.12")

    def test_atomic_consumer_lease_prevents_eviction_after_selection(self) -> None:
        registry = self.registry()
        source = self.disconnect(registry, "192.0.2.10")
        self.time.advance(9.0)

        lease = registry.lease_http("192.0.2.10")
        self.time.advance(20.0)

        self.assertIs(lease.source, source)
        self.assertIn("192.0.2.10", registry.snapshot())
        lease.close()

    def test_active_producer_http_client_and_recording_prevent_eviction(self) -> None:
        registry = self.registry()
        server, peer = socket.socketpair()
        producer = registry.lease_producer("192.0.2.10", server)
        try:
            self.time.advance(20.0)
            self.assertIn("192.0.2.10", registry.snapshot())
            producer.close()

            http = registry.lease_http("192.0.2.10")
            self.time.advance(20.0)
            self.assertIn("192.0.2.10", registry.snapshot())
            http.close()

            recording = registry.lease_recording("192.0.2.10")
            self.time.advance(20.0)
            self.assertIn("192.0.2.10", registry.snapshot())
            recording.close()
        finally:
            producer.close()
            peer.close()
            server.close()

    def test_allowlisted_source_remains_addressable_before_connection(self) -> None:
        registry = self.registry(1, frozenset({"192.0.2.10"}))
        self.time.advance(100.0)
        lifecycle = self.lifecycle(registry.snapshot()["192.0.2.10"])
        self.assertEqual(lifecycle["state"], "allowlisted")
        self.assertEqual(lifecycle["admission"], "allowlisted")
        self.assertFalse(lifecycle["dynamic"])

        lease = registry.lease_http("192.0.2.10")

        self.assertEqual(lease.key, "192.0.2.10")
        lease.close()

    def test_status_exposes_pending_and_disconnected_lifecycle_states(self) -> None:
        registry = self.registry()
        pending = registry.lease_http(None)
        self.assertEqual(self.lifecycle(registry.snapshot()["pending"])["state"], "pending")
        pending.close()

        source = self.disconnect(registry, "192.0.2.10")

        self.assertEqual(self.lifecycle(registry.snapshot()[source.key])["state"], "disconnected")

    def test_source_selection_errors_remain_compatible(self) -> None:
        registry = self.registry()
        with self.assertRaises(SourceSelectionError) as malformed:
            registry.lease_http("bridge.local")
        with self.assertRaises(SourceSelectionError) as missing:
            registry.lease_http("192.0.2.10")
        self.assertEqual(malformed.exception.status, HTTPStatus.BAD_REQUEST)
        self.assertEqual(missing.exception.status, HTTPStatus.NOT_FOUND)

    def test_authenticated_identity_is_dynamic_while_peer_admission_is_allowlisted(self) -> None:
        registry = self.registry(1, frozenset({"192.0.2.10"}))
        key_id = "eli1-00112233445566778899aabbccddeeff"
        server, peer = socket.socketpair()
        try:
            lease = registry.lease_producer(key_id, server, peer_ip="192.0.2.10", transport="tls-psk")

            lifecycle = self.lifecycle(registry.snapshot()[key_id])
            self.assertEqual(lifecycle["peer_ip"], "192.0.2.10")
            self.assertEqual(lifecycle["transport"], "tls-psk")
            self.assertEqual(lifecycle["admission"], "allowlisted")
            self.assertTrue(lifecycle["dynamic"])
        finally:
            lease.close()
            peer.close()
            server.close()

    def test_one_slot_key_rotation_reuses_an_eligible_disconnected_identity(self) -> None:
        registry = self.registry(1, frozenset({"192.0.2.10"}))
        first_key = "eli1-00112233445566778899aabbccddeeff"
        second_key = "eli1-ffeeddccbbaa99887766554433221100"
        first_server, first_peer = socket.socketpair()
        second_server, second_peer = socket.socketpair()
        try:
            first = registry.lease_producer(first_key, first_server, peer_ip="192.0.2.10", transport="tls-psk")
            first.close()

            second = registry.lease_producer(second_key, second_server, peer_ip="192.0.2.10", transport="tls-psk")

            self.assertIs(second.hub, first.hub)
            self.assertEqual(registry.snapshot().keys(), {second_key})
        finally:
            first.close()
            second.close()
            first_peer.close()
            first_server.close()
            second_peer.close()
            second_server.close()

    def test_distinct_tls_identities_from_one_peer_use_available_slots(self) -> None:
        registry = self.registry(2, frozenset({"192.0.2.10"}))
        first_key = "eli1-00112233445566778899aabbccddeeff"
        second_key = "eli1-ffeeddccbbaa99887766554433221100"
        first = self.disconnect(registry, first_key, peer_ip="192.0.2.10", transport="tls-psk")

        second = self.disconnect(registry, second_key, peer_ip="192.0.2.10", transport="tls-psk")

        self.assertIsNot(first, second)
        self.assertEqual(registry.snapshot().keys(), {first_key, second_key})

    def test_active_identity_claims_block_one_slot_key_rotation(self) -> None:
        first_key = "eli1-00112233445566778899aabbccddeeff"
        second_key = "eli1-ffeeddccbbaa99887766554433221100"
        for kind in ("producer", "http", "recording"):
            with self.subTest(kind=kind):
                registry = self.registry(1, frozenset({"192.0.2.10"}))
                source = self.disconnect(registry, first_key, peer_ip="192.0.2.10", transport="tls-psk")
                server, peer = socket.socketpair()
                replacement, replacement_peer = socket.socketpair()
                if kind == "producer":
                    claim = registry.lease_producer(first_key, server, peer_ip="192.0.2.10", transport="tls-psk")
                elif kind == "http":
                    claim = registry.lease_http(first_key)
                else:
                    claim = registry.lease_recording(first_key)
                try:
                    with self.assertRaises(SourceAdmissionError):
                        registry.lease_producer(
                            second_key,
                            replacement,
                            peer_ip="192.0.2.10",
                            transport="tls-psk",
                        )
                    self.assertIs(claim.source, source)
                finally:
                    claim.close()
                    server.close()
                    peer.close()
                    replacement.close()
                    replacement_peer.close()

    def test_active_allowlisted_http_source_is_not_rekeyed_at_capacity(self) -> None:
        registry = self.registry(1, frozenset({"192.0.2.10"}))
        http = registry.lease_http("192.0.2.10")
        server, peer = socket.socketpair()
        try:
            with self.assertRaises(SourceAdmissionError):
                registry.lease_producer(
                    "eli1-00112233445566778899aabbccddeeff",
                    server,
                    peer_ip="192.0.2.10",
                    transport="tls-psk",
                )

            self.assertEqual(http.key, "192.0.2.10")
            self.assertEqual(registry.snapshot().keys(), {"192.0.2.10"})
        finally:
            http.close()
            server.close()
            peer.close()

    def test_active_allowlisted_http_source_gets_a_distinct_tls_slot_when_available(self) -> None:
        registry = self.registry(2, frozenset({"192.0.2.10"}))
        key_id = "eli1-00112233445566778899aabbccddeeff"
        http = registry.lease_http("192.0.2.10")
        server, peer = socket.socketpair()
        producer = registry.lease_producer(key_id, server, peer_ip="192.0.2.10", transport="tls-psk")
        try:
            self.assertIsNot(http.hub, producer.hub)
            self.assertEqual(http.key, "192.0.2.10")
            self.assertEqual(registry.snapshot().keys(), {"192.0.2.10", key_id})
        finally:
            producer.close()
            http.close()
            server.close()
            peer.close()

    def test_allowlist_rejects_an_unlisted_peer_independently_of_identity(self) -> None:
        registry = self.registry(1, frozenset({"192.0.2.10"}))
        server, peer = socket.socketpair()
        try:
            with self.assertRaises(SourceAdmissionError):
                registry.lease_producer(
                    "eli1-ffeeddccbbaa99887766554433221100",
                    server,
                    peer_ip="192.0.2.11",
                    transport="tls-psk",
                )
        finally:
            server.close()
            peer.close()
