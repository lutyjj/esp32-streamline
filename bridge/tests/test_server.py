from __future__ import annotations

import argparse
import socket
import unittest

from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.server import AudioHub, validate_args, wav_header
from streamline_bridge.sources import SourceRegistry, SourceSelectionError, TcpSourceGate


def make_hub() -> AudioHub:
    return AudioHub(
        max_client_chunks=4,
        playout_buffer_seconds=0.01,
        max_repeat_conceal_packets=1,
        max_outage_silence_seconds=1.0,
    )


class TcpSourceGateTests(unittest.TestCase):
    def test_replaced_source_cannot_inject_packets_into_new_session(self) -> None:
        hub = make_hub()
        gate = TcpSourceGate(hub)
        old_source, old_peer = socket.socketpair()
        new_source, new_peer = socket.socketpair()
        payload = bytes(DEFAULT_FORMAT.payload_bytes)

        try:
            old_generation = gate.replace(old_source)
            self.assertTrue(gate.ingest(old_generation, 10, payload))

            new_generation = gate.replace(new_source)
            self.assertFalse(gate.ingest(old_generation, 11, payload))
            self.assertTrue(gate.ingest(new_generation, 0, payload))
            self.assertEqual(hub.snapshot()["last_seq"], 0)
        finally:
            old_peer.close()
            new_peer.close()
            new_source.close()


class SourceRegistryTests(unittest.TestCase):
    def test_bare_stream_creates_pending_source_that_first_producer_adopts(self) -> None:
        registry = SourceRegistry(make_hub, max_sources=2)

        pending = registry.select(None)
        acquired = registry.acquire("192.0.2.10")

        assert acquired is not None
        self.assertIs(acquired.hub, pending.hub)
        self.assertEqual(registry.snapshot().keys(), {"192.0.2.10"})

    def test_bare_stream_requires_source_when_several_producers_exist(self) -> None:
        registry = SourceRegistry(make_hub, max_sources=2)

        self.assertIsNotNone(registry.acquire("192.0.2.10"))
        self.assertIsNotNone(registry.acquire("192.0.2.11"))

        with self.assertRaises(SourceSelectionError) as raised:
            registry.select(None)
        self.assertEqual(raised.exception.status, 409)

    def test_explicit_stream_creates_source_before_producer_connects(self) -> None:
        registry = SourceRegistry(make_hub, max_sources=1)

        source = registry.select("192.0.2.10")

        self.assertIs(registry.acquire("192.0.2.10"), source)

    def test_allowlist_rejects_unlisted_tcp_producer(self) -> None:
        registry = SourceRegistry(make_hub, max_sources=1, allowed=frozenset({"192.0.2.10"}))

        self.assertIsNone(registry.acquire("192.0.2.11"))


class WavHeaderTests(unittest.TestCase):
    def test_wav_header_uses_the_declared_pcm_format(self) -> None:
        header = wav_header()
        self.assertEqual(header[:4], b"RIFF")
        self.assertEqual(header[8:12], b"WAVE")
        self.assertEqual(len(header), 44)


class ArgumentTests(unittest.TestCase):
    def test_normalizes_a_comma_separated_source_allowlist(self) -> None:
        args = argparse.Namespace(
            client_buffer_chunks=4,
            playout_buffer_seconds=1.0,
            max_repeat_conceal_packets=3,
            max_outage_silence_seconds=5.0,
            source_idle_timeout_seconds=5.0,
            max_sources=8,
            source_allow=["192.0.2.10, 198.51.100.20"],
        )

        self.assertEqual(validate_args(args).source_allow, frozenset({"192.0.2.10", "198.51.100.20"}))

    def test_rejects_non_ipv4_source_allowlist_entries(self) -> None:
        args = argparse.Namespace(
            client_buffer_chunks=4,
            playout_buffer_seconds=1.0,
            max_repeat_conceal_packets=3,
            max_outage_silence_seconds=5.0,
            source_idle_timeout_seconds=5.0,
            max_sources=8,
            source_allow=["bridge.local"],
        )

        with self.assertRaises(SystemExit):
            validate_args(args)

    def test_rejects_allowlist_larger_than_max_sources(self) -> None:
        args = argparse.Namespace(
            client_buffer_chunks=4,
            playout_buffer_seconds=1.0,
            max_repeat_conceal_packets=3,
            max_outage_silence_seconds=5.0,
            source_idle_timeout_seconds=5.0,
            max_sources=1,
            source_allow=["192.0.2.10, 198.51.100.20"],
        )

        with self.assertRaises(SystemExit):
            validate_args(args)
