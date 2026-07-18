"""Shared fixtures for the recording test modules."""

from __future__ import annotations

import socket
import tempfile
import time
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.recording import RecordingService, RecordingStore
from streamline_bridge.sources import Source, SourceRegistry


class FixedTime:
    def __init__(self) -> None:
        self.value = datetime(2026, 7, 11, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


def payload(sample: int) -> bytes:
    return sample.to_bytes(2, "little", signed=True) * (DEFAULT_FORMAT.payload_bytes // 2)


class RecordingServiceHarness(unittest.TestCase):
    """One connected source, a pinned store, and a running service."""

    def connect_source(
        self,
        key: str,
        *,
        peer_ip: str | None = None,
        transport: str = "cleartext",
    ) -> Source[AudioPipeline]:
        server, peer = socket.socketpair()
        lease = self.sources.lease_producer(key, server, peer_ip=peer_ip, transport=transport)
        self.addCleanup(peer.close)
        self.addCleanup(server.close)
        self.addCleanup(lease.close)
        return lease.source

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = RecordingStore(Path(self.temp.name), now=FixedTime())
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.source = self.connect_source("192.0.2.10")
        self.service = RecordingService(self.sources, self.store)
        self.addCleanup(self.service.shutdown)

    def wait_for_saved(self) -> dict[str, object]:
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            saved = cast("list[dict[str, object]]", self.service.list()["saved"])
            if saved:
                return saved[0]
            time.sleep(0.01)
        self.fail("recording did not finalize")
        raise AssertionError
