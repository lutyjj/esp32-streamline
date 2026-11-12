from __future__ import annotations

import asyncio
import struct
import unittest
from typing import TYPE_CHECKING, Any, cast
from unittest.mock import patch

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

from streamline_bridge.sendspin import publisher as publisher_module
from streamline_bridge.sendspin.packet_feed import Packet
from streamline_bridge.sendspin.publisher import SendspinPublisher, build_client

if TYPE_CHECKING:
    from collections.abc import Callable

    from aiosendspin.client import SendspinClient

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
        self.port = self.http.port
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
        await self._pair_again()

    async def _pair_again(self) -> None:
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

    def _stream_starts(self, client: Any) -> asyncio.Queue[Any]:
        """Collect the server-side handle of every stream the publisher opens."""
        handles: asyncio.Queue[Any] = asyncio.Queue()
        client.add_event_listener(
            lambda _client, event: (
                handles.put_nowait(event.handle) if isinstance(event, SourceStreamStartedEvent) else None
            )
        )
        return handles

    @staticmethod
    async def _receive(handle: Any, size: int) -> bytes:
        received = bytearray()
        async with asyncio.timeout(5):
            async for chunk, _timestamp in handle:
                received += chunk
                if len(received) >= size:
                    break
        return bytes(received[:size])

    async def test_unpaired_source_connects_without_an_enabled_input(self) -> None:
        self.publisher.start()
        await eventually(lambda: self.publisher.snapshot()["connection"] == "connected")

        await self.publisher.report_signal(SignalState.PRESENT)

        snapshot = self.publisher.snapshot()
        self.assertFalse(snapshot["paired"])
        self.assertFalse(snapshot["input_enabled"])
        self.assertIsNone(snapshot["signal"])

    async def test_keeps_dialing_until_the_server_comes_up(self) -> None:
        await self.http.close()
        self.publisher.start()
        await asyncio.sleep(0.2)
        self.assertEqual(self.publisher.snapshot()["connection"], "connecting")

        app = web.Application()
        app.router.add_get(SendspinServer.API_PATH, self.server.on_client_connect)
        self.http = TestServer(app, port=self.port)
        await self.http.start_server()

        await eventually(lambda: self.publisher.snapshot()["connection"] == "connected", timeout=10)

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

    async def test_a_start_right_after_a_stop_opens_a_new_stream(self) -> None:
        await self._pair()
        await self._report(SignalState.PRESENT)
        client, role = self._source_role()
        handles = self._stream_starts(client)
        role.request_start()
        await eventually(lambda: self.feeds)

        # Music Assistant moves a playing input by stopping and starting it at once.
        role.request_stop()
        role.request_start()
        await eventually(lambda: len(self.feeds) == 2)
        now = self.clock.now_us()
        sent = [tone(100 + index) for index in range(10)]
        for index, payload in enumerate(sent):
            self.feeds[1].packets.put_nowait(Packet(index, now + index * 5_333, payload))
        handle = await asyncio.wait_for(handles.get(), 5)
        while not handles.empty():
            handle = handles.get_nowait()

        self.assertTrue(self.feeds[0].closed)
        self.assertEqual(await self._receive(handle, 1_200 * 4), b"".join(sent)[: 1_200 * 4])

    async def test_pairing_again_reports_the_signal_to_the_reactivated_input(self) -> None:
        await self._pair()
        client, _role = self._source_role()
        signals: list[SignalState] = []
        client.add_event_listener(
            lambda _client, event: signals.append(event.signal) if isinstance(event, SourceSignalChangedEvent) else None
        )
        await self._report(SignalState.PRESENT)
        await eventually(lambda: signals == [SignalState.PRESENT])

        await self._pair_again()
        async with asyncio.timeout(5):
            while signals != [SignalState.PRESENT, SignalState.PRESENT]:
                await self.publisher.report_signal(SignalState.PRESENT)
                await asyncio.sleep(0.05)

        self.assertTrue(self.publisher.snapshot()["input_enabled"])

    async def test_capture_older_than_the_backlog_bound_is_dropped_and_streaming_resumes(self) -> None:
        await self._pair()
        await self._report(SignalState.PRESENT)
        client, role = self._source_role()
        handles = self._stream_starts(client)
        role.request_start()
        await eventually(lambda: self.feeds)
        feed = self.feeds[0]
        stalled = self.clock.now_us() - 1_000_000
        for index in range(10):
            feed.packets.put_nowait(Packet(index, stalled + index * 5_333, tone(index)))
        # The device dropped the packets of a one-second stall; the next ones arrive on time.
        resumed = [tone(500 + index) for index in range(10)]
        for index, payload in enumerate(resumed):
            feed.packets.put_nowait(Packet(188 + index, self.clock.now_us() + index * 5_333, payload))
        handle = await asyncio.wait_for(handles.get(), 5)

        self.assertEqual(await self._receive(handle, 1_200 * 4), b"".join(resumed)[: 1_200 * 4])


class FakeConnection:
    def __init__(self) -> None:
        self.connected = True
        self.source_active = True
        self.sent: list[SignalState] = []

    def _is_role_active(self, family: str) -> bool:
        return family == "source" and self.source_active

    async def send_source_signal(self, signal: SignalState) -> None:
        self.sent.append(signal)


class ConnectedClient:
    def __init__(self, connection: FakeConnection) -> None:
        self.identity = Identity.generate()
        self.client_name = f"StreamLine {SOURCE}"
        self.noise_psk = None
        self._admitted_connection = connection

    @property
    def connected(self) -> bool:
        return self._admitted_connection.connected


class SendspinPublisherInputStateTests(unittest.IsolatedAsyncioTestCase):
    async def test_input_state_and_signal_follow_the_source_role(self) -> None:
        connection = FakeConnection()
        publisher = SendspinPublisher(
            SOURCE,
            "ws://192.0.2.30:8927/sendspin",
            cast("SendspinClient", ConnectedClient(connection)),
            lambda _source: FakeFeed(),
        )
        await publisher.report_signal(SignalState.PRESENT)
        self.assertEqual((publisher.snapshot()["input_enabled"], publisher.snapshot()["signal"]), (True, "present"))

        connection.source_active = False
        await publisher.report_signal(SignalState.PRESENT)
        self.assertEqual((publisher.snapshot()["input_enabled"], publisher.snapshot()["signal"]), (False, None))

        connection.source_active = True
        await publisher.report_signal(SignalState.PRESENT)
        self.assertEqual(connection.sent, [SignalState.PRESENT, SignalState.PRESENT])


class UnresponsiveClient:
    def __init__(self) -> None:
        self.identity = Identity.generate()
        self.client_name = f"StreamLine {SOURCE}"

    async def disconnect(self) -> None:
        await asyncio.Event().wait()


class SendspinPublisherCloseTests(unittest.IsolatedAsyncioTestCase):
    async def test_close_does_not_wait_on_an_unresponsive_server(self) -> None:
        publisher = SendspinPublisher(
            SOURCE,
            "ws://192.0.2.30:8927/sendspin",
            cast("SendspinClient", UnresponsiveClient()),
            lambda _source: FakeFeed(),
        )

        with patch.object(publisher_module, "DISCONNECT_TIMEOUT_SECONDS", 0.05):
            async with asyncio.timeout(2):
                await publisher.close()


if __name__ == "__main__":
    unittest.main()
