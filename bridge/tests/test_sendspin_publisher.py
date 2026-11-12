from __future__ import annotations

import asyncio
import struct
import unittest
from typing import TYPE_CHECKING, Any

from aiohttp import web
from aiohttp.test_utils import TestServer
from aiosendspin.clock import RawMonotonicClock
from aiosendspin.models.types import PairMethod, SignalState
from aiosendspin.noise.keys import Identity
from aiosendspin.noise.pairing import PairingAttempt
from aiosendspin.noise.pairing_token import decode_psk_token
from aiosendspin.noise.trust_store import InMemoryClientPairingStore, InMemoryServerPairingStore
from aiosendspin.server.roles.source import SourceSignalChangedEvent, SourceStreamStartedEvent
from aiosendspin.server.roles.source.v1 import SourceV1Role
from aiosendspin.server.server import SendspinServer

from streamline_bridge.sendspin.packet_feed import Packet
from streamline_bridge.sendspin.publisher import SendspinPublisher, build_client

if TYPE_CHECKING:
    from collections.abc import Callable

SOURCE = "192.0.2.10"
PAYLOAD_BYTES = 256 * 4


def tone(seed: int) -> bytes:
    return b"".join(struct.pack("<hh", seed + frame, -seed - frame) for frame in range(256))


async def eventually(predicate: Callable[[], object], timeout: float = 5.0) -> None:
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


class FakeFeed:
    """Stands in for a leased source: the test pushes the packets the device sent."""

    def __init__(self) -> None:
        self.packets: asyncio.Queue[Packet] = asyncio.Queue()
        self.dropped = 0
        self.closed = False

    async def get(self) -> Packet:
        return await self.packets.get()

    def close(self) -> None:
        self.closed = True


class SendspinPublisherTests(unittest.IsolatedAsyncioTestCase):
    """Drive a publisher against aiosendspin's own server over a real WebSocket."""

    async def asyncSetUp(self) -> None:
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
        self.feeds: list[FakeFeed] = []
        self.clock = RawMonotonicClock()
        client = build_client(
            Identity.generate(), f"StreamLine {SOURCE}", InMemoryClientPairingStore(), self.clock, "test"
        )
        url = f"ws://127.0.0.1:{self.http.port}{SendspinServer.API_PATH}"
        self.publisher = SendspinPublisher(SOURCE, url, client, self._open_feed)

    async def asyncTearDown(self) -> None:
        await self.publisher.close()
        await self.http.close()
        await self.server.close()

    def _open_feed(self, source: str) -> FakeFeed:
        self.assertEqual(source, SOURCE)
        feed = FakeFeed()
        self.feeds.append(feed)
        return feed

    async def _pair(self) -> None:
        """Pair the live connection the way Music Assistant's token setup does."""
        self.publisher.start()
        await eventually(lambda: self.publisher.snapshot()["connection"] == "connected")
        token = decode_psk_token(await self.publisher.create_pairing_token())
        self.assertEqual(token.client_id, self.publisher.client_id)
        await self.server.initiate_pairing(
            token.client_id,
            PairingAttempt(PairMethod.PAIRING_PSK, client_id=token.client_id, pairing_psk=token.pairing_psk),
        )
        await eventually(lambda: self.publisher.snapshot()["paired"])

    async def _report(self, signal: SignalState) -> None:
        async with asyncio.timeout(5):
            while self.publisher.snapshot()["signal"] != signal.value:
                await self.publisher.report_signal(signal)
                await asyncio.sleep(0.05)

    def _source_role(self) -> tuple[Any, SourceV1Role]:
        client = self.server.get_client(self.publisher.client_id)
        assert client is not None
        role = client.role("source@v1")
        assert isinstance(role, SourceV1Role)
        return client, role

    async def test_unpaired_source_connects_without_an_enabled_input(self) -> None:
        self.publisher.start()
        await eventually(lambda: self.publisher.snapshot()["connection"] == "connected")

        await self.publisher.report_signal(SignalState.PRESENT)

        snapshot = self.publisher.snapshot()
        self.assertFalse(snapshot["paired"])
        self.assertFalse(snapshot["input_enabled"])
        self.assertIsNone(snapshot["signal"])

    async def test_pairing_token_enables_the_input_and_reports_the_line_signal(self) -> None:
        await self._pair()
        await self._report(SignalState.ABSENT)
        client, _role = self._source_role()
        signals: list[SignalState] = []
        client.add_event_listener(
            lambda _client, event: signals.append(event.signal) if isinstance(event, SourceSignalChangedEvent) else None
        )

        await self._report(SignalState.PRESENT)

        await eventually(lambda: signals == [SignalState.PRESENT])
        self.assertTrue(self.publisher.snapshot()["input_enabled"])

    async def test_server_start_streams_device_packets_and_silence_records(self) -> None:
        await self._pair()
        await self._report(SignalState.PRESENT)
        client, role = self._source_role()
        started: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        client.add_event_listener(
            lambda _client, event: (
                started.set_result(event)
                if isinstance(event, SourceStreamStartedEvent) and not started.done()
                else None
            )
        )

        role.request_start()
        await eventually(lambda: self.feeds)
        feed = self.feeds[0]
        now = self.clock.now_us()
        # Ten packets cover two 25 ms Sendspin PCM chunks; the third is a silence record.
        sent = [b"" if index == 2 else tone(index) for index in range(10)]
        for index, payload in enumerate(sent):
            feed.packets.put_nowait(Packet(41 + index, now + index * 5_333, payload))
        handle = (await asyncio.wait_for(started, 5)).handle
        expected = b"".join(payload or bytes(PAYLOAD_BYTES) for payload in sent)[: 2 * 1_200 * 4]
        received = bytearray()
        async with asyncio.timeout(5):
            async for chunk, _timestamp in handle:
                received += chunk
                if len(received) >= len(expected):
                    break

        self.assertEqual(bytes(received[: len(expected)]), expected)
        self.assertTrue(self.publisher.snapshot()["streaming"])

        role.request_stop()
        await eventually(lambda: feed.closed)
        await eventually(lambda: not self.publisher.snapshot()["streaming"])


if __name__ == "__main__":
    unittest.main()
