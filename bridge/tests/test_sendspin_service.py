from __future__ import annotations

import asyncio
import socket
import tempfile
import unittest
from pathlib import Path
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

from aiohttp import web
from aiohttp.test_utils import TestServer
from aiosendspin.clock import ManualClock
from aiosendspin.models.types import PairMethod, SignalState
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.pairing import PairingAttempt
from aiosendspin.noise.pairing_token import decode_psk_token
from aiosendspin.noise.trust_store import InMemoryServerPairingStore
from aiosendspin.server.roles.source import SourceStreamStartedEvent
from aiosendspin.server.roles.source.v1 import SourceV1Role
from aiosendspin.server.server import SendspinServer

from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sendspin.identity import SendspinIdentityStore
from streamline_bridge.sendspin.packet_feed import PacketFeed
from streamline_bridge.sendspin.publisher import SendspinPublisher
from streamline_bridge.sendspin.service import SendspinService, line_signal
from streamline_bridge.sources import SourceLease, SourceRegistry

if TYPE_CHECKING:
    from collections.abc import Callable

SOURCE = "192.0.2.10"
AUDIO = b"\x01\x00\x02\x00" * 256


def make_registry(now: Callable[[], float] = lambda: 0.0) -> SourceRegistry[AudioPipeline]:
    return SourceRegistry(
        lambda: AudioPipeline(64, 0.001, 1, 1.0, start_worker=False),
        max_sources=4,
        eviction_idle_seconds=10.0,
        now=now,
    )


async def eventually(predicate: Callable[[], object], timeout: float = 10.0) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.02)


class LineSignalTests(unittest.TestCase):
    def test_only_a_connected_source_with_audio_reports_a_signal(self) -> None:
        def source(state: str, signal: str | None) -> dict[str, object]:
            return {"signal": signal, "lifecycle": {"state": state}}

        self.assertEqual(line_signal(source("connected", "present")), SignalState.PRESENT)
        self.assertEqual(line_signal(source("connected", "absent")), SignalState.ABSENT)
        self.assertEqual(line_signal(source("connected", None)), SignalState.ABSENT)
        self.assertEqual(line_signal(source("disconnected", "present")), SignalState.ABSENT)


class PacketFeedTests(unittest.IsolatedAsyncioTestCase):
    async def test_queues_accepted_packets_and_releases_its_lease(self) -> None:
        registry = make_registry()
        producer, _peer = socket.socketpair()
        lease = registry.lease_producer(SOURCE, producer)
        feed = PacketFeed(registry.lease_sendspin(SOURCE), asyncio.get_running_loop(), ManualClock(7), capacity=2)

        for sequence in range(3):
            lease.ingest(sequence, AUDIO)
        packets = [await feed.get(), await feed.get()]

        self.assertEqual([(packet.sequence, packet.arrival_us) for packet in packets], [(1, 7), (2, 7)])
        self.assertEqual(feed.dropped, 1)
        self.assertEqual(registry.snapshot()[SOURCE]["lifecycle"]["sendspin_streams"], 1)  # type: ignore[index]
        feed.close()
        lease.ingest(3, AUDIO)
        await asyncio.sleep(0)
        self.assertEqual(registry.snapshot()[SOURCE]["lifecycle"]["sendspin_streams"], 0)  # type: ignore[index]
        lease.close()
        producer.close()
        _peer.close()


class SendspinServiceTests(unittest.IsolatedAsyncioTestCase):
    """Run the service's own loop against aiosendspin's server on the test loop."""

    async def asyncSetUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.server_store = InMemoryServerPairingStore()
        self.server = SendspinServer(
            loop=asyncio.get_running_loop(),
            identity=Identity.generate(),
            server_name="music-assistant",
            pairing_store=self.server_store,
        )
        app = web.Application()
        app.router.add_get(SendspinServer.API_PATH, self.server.on_client_connect)
        self.http = TestServer(app)
        await self.http.start_server()
        self.url = f"ws://127.0.0.1:{self.http.port}{SendspinServer.API_PATH}"
        self.now = [0.0]
        self.registry = make_registry(lambda: self.now[0])
        self.sockets = socket.socketpair()
        self.services: list[SendspinService] = []

    async def asyncTearDown(self) -> None:
        for service in self.services:
            await asyncio.to_thread(service.close)
        await self.http.close()
        await self.server.close()
        for end in self.sockets:
            end.close()
        self._directory.cleanup()

    def start_service(self) -> SendspinService:
        identities = SendspinIdentityStore(Path(self._directory.name))
        service = SendspinService(self.registry, self.url, identities, "test")
        self.services.append(service)
        service.start()
        return service

    def connect_device(self) -> SourceLease[AudioPipeline]:
        return self.registry.lease_producer(SOURCE, self.sockets[0])

    def published(self, service: SendspinService) -> list[dict[str, Any]]:
        return service.snapshot()["sources"]  # type: ignore[return-value]

    async def test_publishes_a_connected_source_and_retires_it_on_eviction(self) -> None:
        producer = self.connect_device()
        service = self.start_service()

        await eventually(lambda: [s["connection"] for s in self.published(service)] == ["connected"])
        client_id = self.published(service)[0]["client_id"]
        await eventually(lambda: self.server.get_client(client_id) is not None)

        producer.close()
        self.now[0] = 60.0
        await eventually(lambda: self.published(service) == [])
        self.assertNotIn(SOURCE, self.registry.snapshot())

    async def test_a_failing_publisher_does_not_stop_publishing_other_sources(self) -> None:
        self.connect_device()
        with patch.object(SendspinPublisher, "report_signal", side_effect=ValueError("broken publisher")):
            service = self.start_service()
            await eventually(lambda: len(self.published(service)) == 1)
            other, _peer = socket.socketpair()
            self.addCleanup(other.close)
            self.addCleanup(_peer.close)
            self.registry.lease_producer("192.0.2.11", other)

            await eventually(lambda: [s["source"] for s in self.published(service)] == [SOURCE, "192.0.2.11"])

    async def test_a_source_keeps_its_client_id_across_restarts(self) -> None:
        self.connect_device()
        first = self.start_service()
        await eventually(lambda: self.published(first))
        client_id = self.published(first)[0]["client_id"]
        await asyncio.to_thread(first.close)

        second = self.start_service()

        await eventually(lambda: self.published(second))
        self.assertEqual(self.published(second)[0]["client_id"], client_id)

    async def test_pairing_token_requires_a_published_source(self) -> None:
        service = self.start_service()

        with self.assertRaises(LookupError):
            await asyncio.to_thread(service.create_pairing_token, SOURCE)

    async def test_streams_the_device_while_music_assistant_listens(self) -> None:
        producer = self.connect_device()
        service = self.start_service()
        await eventually(lambda: self.published(service))
        await eventually(lambda: self.published(service)[0]["connection"] == "connected")
        # Music Assistant's token setup: pair the live connection with the pasted token.
        token = decode_psk_token((await asyncio.to_thread(service.create_pairing_token, SOURCE))["token"])
        await self.server.initiate_pairing(
            token.client_id,
            PairingAttempt(PairMethod.PAIRING_PSK, client_id=token.client_id, pairing_psk=token.pairing_psk),
        )
        await eventually(lambda: self.published(service)[0]["paired"])
        producer.ingest(1, AUDIO)
        await eventually(lambda: self.published(service)[0]["signal"] == "present")
        client = self.server.get_client(token.client_id)
        assert client is not None
        role = client.role("source@v1")
        assert isinstance(role, SourceV1Role)
        started: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        client.add_event_listener(
            lambda _client, event: (
                started.set_result(event)
                if isinstance(event, SourceStreamStartedEvent) and not started.done()
                else None
            )
        )

        role.request_start()
        await eventually(lambda: self.registry.snapshot()[SOURCE]["lifecycle"]["sendspin_streams"] == 1)  # type: ignore[index]
        for sequence in range(2, 12):
            producer.ingest(sequence, AUDIO)
        handle = (await asyncio.wait_for(started, 5)).handle
        async with asyncio.timeout(5):
            chunk, _timestamp = await anext(aiter(handle))

        self.assertEqual(chunk[: len(AUDIO)], AUDIO)
        role.request_stop()
        await eventually(lambda: self.registry.snapshot()[SOURCE]["lifecycle"]["sendspin_streams"] == 0)  # type: ignore[index]

    async def test_losing_music_assistant_mid_stream_releases_the_source(self) -> None:
        producer = self.connect_device()
        service = self.start_service()
        await eventually(lambda: self.published(service) and self.published(service)[0]["connection"] == "connected")
        token = decode_psk_token((await asyncio.to_thread(service.create_pairing_token, SOURCE))["token"])
        await self.server.initiate_pairing(
            token.client_id,
            PairingAttempt(PairMethod.PAIRING_PSK, client_id=token.client_id, pairing_psk=token.pairing_psk),
        )
        producer.ingest(1, AUDIO)
        await eventually(lambda: self.published(service)[0]["signal"] == "present")
        client = self.server.get_client(token.client_id)
        assert client is not None
        role = client.role("source@v1")
        assert isinstance(role, SourceV1Role)
        role.request_start()
        await eventually(lambda: self.registry.snapshot()[SOURCE]["lifecycle"]["sendspin_streams"] == 1)  # type: ignore[index]

        await self.http.close()
        await self.server.close()

        await eventually(lambda: self.registry.snapshot()[SOURCE]["lifecycle"]["sendspin_streams"] == 0)  # type: ignore[index]
        await eventually(lambda: self.published(service)[0]["connection"] == "connecting")


if __name__ == "__main__":
    unittest.main()
