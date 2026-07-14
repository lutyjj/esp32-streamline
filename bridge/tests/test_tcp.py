from __future__ import annotations

import socket
import time
import unittest
from typing import cast

from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.protocol import DEFAULT_FORMAT, HEADER, MAGIC, VERSION
from streamline_bridge.sources import Source, SourceRegistry
from streamline_bridge.tcp import AuthenticatedConnection, TcpIngestServer, receive_source


def packet(sequence: int, magic: bytes = MAGIC) -> bytes:
    payload = bytes(DEFAULT_FORMAT.payload_bytes)
    return (
        HEADER.pack(
            magic,
            VERSION,
            HEADER.size,
            DEFAULT_FORMAT.channels,
            DEFAULT_FORMAT.bits,
            sequence,
            DEFAULT_FORMAT.rate,
            DEFAULT_FORMAT.frames_per_packet,
            len(payload),
        )
        + payload
    )


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


class TcpAdapterTests(unittest.TestCase):
    def prepare(self) -> tuple[SourceRegistry[AudioPipeline], Source[AudioPipeline], socket.socket, socket.socket, int]:
        registry = SourceRegistry(make_pipeline, max_sources=1)
        source = registry.acquire("192.0.2.10")
        server, peer = socket.socketpair()
        generation = registry.connect(source, server)
        return registry, source, server, peer, generation

    def test_fragmented_input_is_reassembled(self) -> None:
        registry, source, server, peer, generation = self.prepare()
        try:
            encoded = packet(9)
            for offset in range(0, len(encoded), 17):
                peer.sendall(encoded[offset : offset + 17])
            peer.shutdown(socket.SHUT_WR)
            receive_source(registry, source, generation, server, ("192.0.2.10", 39000))
            self.assertEqual(source.hub.snapshot()["packets"], 1)
        finally:
            peer.close()

    def test_malformed_input_increments_tcp_error(self) -> None:
        registry, source, server, peer, generation = self.prepare()
        try:
            peer.sendall(packet(9, magic=b"nope"))
            receive_source(registry, source, generation, server, ("192.0.2.10", 39000))
            self.assertEqual(source.hub.snapshot()["tcp_errors"], 1)
        finally:
            peer.close()

    def test_idle_timeout_increments_tcp_error_and_disconnects_source(self) -> None:
        registry, source, server, peer, generation = self.prepare()
        server.settimeout(0.001)
        try:
            receive_source(registry, source, generation, server, ("192.0.2.10", 39000))
            snapshot = registry.snapshot()["192.0.2.10"]
            self.assertEqual(source.hub.snapshot()["tcp_errors"], 1)
            lifecycle = cast("dict[str, object]", snapshot["lifecycle"])
            self.assertEqual(lifecycle["state"], "disconnected")
        finally:
            peer.close()

    def test_new_connection_replaces_old_connection(self) -> None:
        registry, source, server, peer, first_generation = self.prepare()
        replacement, replacement_peer = socket.socketpair()
        try:
            second_generation = registry.connect(source, replacement)
            self.assertFalse(source.gate.ingest(first_generation, 1, bytes(DEFAULT_FORMAT.payload_bytes)))
            self.assertTrue(source.gate.ingest(second_generation, 0, bytes(DEFAULT_FORMAT.payload_bytes)))
            self.assertEqual(source.hub.snapshot()["last_seq"], 0)
        finally:
            peer.close()
            replacement_peer.close()
            replacement.close()
            server.close()

    def test_ingest_worker_count_is_bounded(self) -> None:
        registry = SourceRegistry(make_pipeline, max_sources=2)
        ingest = TcpIngestServer(registry, "127.0.0.1", 0, 1.0, max_connections=1)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        first_peer = socket.create_connection(listener.getsockname())
        first, first_addr = listener.accept()
        second_peer = socket.create_connection(listener.getsockname())
        second, second_addr = listener.accept()
        try:
            ingest.accept(first, first_addr)
            ingest.accept(second, second_addr)

            self.assertEqual(second.fileno(), -1)
            first_peer.close()
            deadline = time.monotonic() + 1
            lifecycle: dict[str, object] = {}
            while time.monotonic() < deadline:
                snapshot = registry.snapshot().get(first_addr[0])
                if snapshot is None:
                    time.sleep(0.01)
                    continue
                lifecycle = cast("dict[str, object]", snapshot["lifecycle"])
                if lifecycle["state"] == "disconnected":
                    break
                time.sleep(0.01)
            self.assertEqual(lifecycle["state"], "disconnected")
        finally:
            first_peer.close()
            second_peer.close()
            listener.close()

    def test_authentication_failure_creates_no_source_pipeline(self) -> None:
        class Reject:
            def authenticate(self, _conn: socket.socket, _addr: tuple[str, int]) -> AuthenticatedConnection:
                raise ValueError("authentication failed")

        class RejectSource:
            def producer_authenticator(self) -> Reject:
                return Reject()

        registry = SourceRegistry(make_pipeline, max_sources=1)
        ingest = TcpIngestServer(registry, "127.0.0.1", 0, 1.0, max_connections=1, authenticators=RejectSource())
        server, peer = socket.socketpair()
        try:
            ingest.accept(server, ("192.0.2.10", 1234))
            deadline = time.monotonic() + 1
            while server.fileno() != -1 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(registry.snapshot(), {})
        finally:
            peer.close()

    def test_close_producers_drops_a_live_connection(self) -> None:
        registry = SourceRegistry(make_pipeline, max_sources=1)
        ingest = TcpIngestServer(registry, "127.0.0.1", 0, 5.0, max_connections=1)
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        peer = socket.create_connection(listener.getsockname())
        conn, addr = listener.accept()
        try:
            ingest.accept(conn, addr)
            self.assertEqual(self.wait_for_state(registry, addr[0], "connected"), "connected")

            ingest.close_producers()

            self.assertEqual(self.wait_for_state(registry, addr[0], "disconnected"), "disconnected")
        finally:
            peer.close()
            listener.close()

    @staticmethod
    def wait_for_state(registry: SourceRegistry[AudioPipeline], key: str, wanted: str) -> str:
        deadline = time.monotonic() + 1
        state = ""
        while time.monotonic() < deadline:
            snapshot = registry.snapshot().get(key)
            if snapshot is not None:
                state = str(cast("dict[str, object]", snapshot["lifecycle"])["state"])
                if state == wanted:
                    return state
            time.sleep(0.01)
        return state
