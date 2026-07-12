from __future__ import annotations

import socket
import unittest
from http import HTTPStatus
from typing import cast

from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceAdmissionError, SourceRegistry, SourceSelectionError


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

    def disconnect(self, registry: SourceRegistry[AudioPipeline], ip: str) -> object:
        source = registry.acquire(ip)
        server, peer = socket.socketpair()
        try:
            generation = registry.connect(source, server)
            registry.disconnect(source, generation, server)
        finally:
            peer.close()
            server.close()
        return source

    @staticmethod
    def lifecycle(snapshot: dict[str, object]) -> dict[str, object]:
        return cast("dict[str, object]", snapshot["lifecycle"])

    def test_bare_stream_creates_pending_source_that_first_producer_adopts(self) -> None:
        registry = self.registry()
        pending = registry.select(None)
        acquired = registry.acquire("192.0.2.10")
        self.assertIs(acquired.hub, pending.hub)
        self.assertEqual(registry.snapshot().keys(), {"192.0.2.10"})

    def test_reconnect_before_expiry_preserves_pipeline(self) -> None:
        registry = self.registry()
        first = self.disconnect(registry, "192.0.2.10")
        self.time.advance(9.0)
        self.assertIs(registry.acquire("192.0.2.10"), first)

    def test_disconnected_dynamic_source_is_evicted_and_admission_recovers_after_ip_churn(self) -> None:
        registry = self.registry(max_sources=2)
        self.disconnect(registry, "192.0.2.10")
        self.disconnect(registry, "192.0.2.11")
        with self.assertRaises(SourceAdmissionError):
            registry.acquire("192.0.2.12")
        self.time.advance(10.0)
        admitted = registry.acquire("192.0.2.12")
        self.assertEqual(admitted.key, "192.0.2.12")

    def test_active_producer_http_client_and_recording_prevent_eviction(self) -> None:
        registry = self.registry()
        source = registry.acquire("192.0.2.10")
        server, peer = socket.socketpair()
        try:
            registry.connect(source, server)
            self.time.advance(20.0)
            self.assertIs(registry.select("192.0.2.10"), source)
            registry.disconnect(source, 1, server)
            registry.retain_http(source)
            self.time.advance(20.0)
            self.assertIs(registry.select("192.0.2.10"), source)
            registry.release_http(source)
            registry.retain_recording(source)
            self.time.advance(20.0)
            self.assertIs(registry.select("192.0.2.10"), source)
        finally:
            registry.release_recording(source)
            peer.close()
            server.close()

    def test_allowlisted_source_remains_addressable_before_connection(self) -> None:
        registry = self.registry(1, frozenset({"192.0.2.10"}))
        self.time.advance(100.0)
        source = registry.select("192.0.2.10")
        self.assertEqual(self.lifecycle(registry.snapshot()["192.0.2.10"])["state"], "allowlisted")
        self.assertIs(registry.acquire("192.0.2.10"), source)

    def test_status_exposes_each_lifecycle_state(self) -> None:
        registry = self.registry()
        pending = registry.select(None)
        self.assertEqual(self.lifecycle(registry.snapshot()["pending"])["state"], "pending")
        source = registry.acquire("192.0.2.10")
        self.assertIs(source.hub, pending.hub)
        self.assertEqual(self.lifecycle(registry.snapshot()["192.0.2.10"])["state"], "disconnected")

    def test_source_selection_errors_remain_compatible(self) -> None:
        registry = self.registry()
        with self.assertRaises(SourceSelectionError) as malformed:
            registry.select("bridge.local")
        with self.assertRaises(SourceSelectionError) as missing:
            registry.select("192.0.2.10")
        self.assertEqual(malformed.exception.status, HTTPStatus.BAD_REQUEST)
        self.assertEqual(missing.exception.status, HTTPStatus.NOT_FOUND)
