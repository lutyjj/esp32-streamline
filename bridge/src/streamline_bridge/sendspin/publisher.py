"""Publish one StreamLine source to Music Assistant as a Sendspin source client."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import TYPE_CHECKING, Protocol

from aiosendspin.client import SendspinClient
from aiosendspin.models.core import DeviceInfo
from aiosendspin.models.player import SupportedAudioFormat
from aiosendspin.models.source import ClientHelloSourceFeatures, ClientHelloSourceSupport
from aiosendspin.models.types import AudioCodec, Roles, SignalState
from aiosendspin.noise.keys import generate_psk, psk_id_for
from aiosendspin.noise.pairing_token import PSKPairingToken, encode_psk_token
from aiosendspin.noise.trust_store import PairingPsk, PskCategory

from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.sendspin.capture_clock import CaptureClock

if TYPE_CHECKING:
    from collections.abc import Callable

    from aiosendspin.client.connection import SendspinConnection
    from aiosendspin.clock import Clock
    from aiosendspin.models.core import ServerCommandPayload
    from aiosendspin.noise.keys import Identity
    from aiosendspin.noise.trust_store import ClientPairingStore

    from streamline_bridge.sendspin.packet_feed import Packet

logger = logging.getLogger(__name__)

CAPTURE_FORMAT = SupportedAudioFormat(
    codec=AudioCodec.PCM,
    channels=DEFAULT_FORMAT.channels,
    sample_rate=DEFAULT_FORMAT.rate,
    bit_depth=DEFAULT_FORMAT.bits,
)
RECONNECT_INITIAL_SECONDS = 1.0
RECONNECT_MAX_SECONDS = 30.0


class SourceFeed(Protocol):
    """Packets of one source, held for the publisher while it streams."""

    dropped: int

    async def get(self) -> Packet: ...
    def close(self) -> None: ...


def build_client(
    identity: Identity,
    name: str,
    pairing_store: ClientPairingStore,
    clock: Clock,
    software_version: str,
) -> SendspinClient:
    """Create a source-only client that reports line-in signal presence."""
    return SendspinClient(
        identity,
        name,
        [Roles.SOURCE],
        pairing_store=pairing_store,
        device_info=DeviceInfo(
            product_name="StreamLine line-in",
            manufacturer="ESP32 StreamLine",
            software_version=software_version,
        ),
        source_support=ClientHelloSourceSupport(features=ClientHelloSourceFeatures(line_sense=True)),
        clock=clock,
    )


class SendspinPublisher:
    """Keep one source connected to a Sendspin server and stream it on request.

    The server decides when audio flows: it sends ``start`` when a listener
    selects the input and ``stop`` when it is released. The device signal gate
    becomes the ``line_sense`` signal, so the server can start playback when a
    record starts.
    """

    def __init__(
        self,
        source: str,
        server_url: str,
        client: SendspinClient,
        open_feed: Callable[[str], SourceFeed],
    ) -> None:
        self.source = source
        self._server_url = server_url
        self._client = client
        self._open_feed = open_feed
        self._silence = bytes(DEFAULT_FORMAT.payload_bytes)
        self._disconnected = asyncio.Event()
        self._runner: asyncio.Task[None] | None = None
        self._stream: asyncio.Task[None] | None = None
        self._reported: SignalState | None = None
        self._input_enabled = False

    @property
    def client_id(self) -> str:
        return self._client.identity.peer_id

    @property
    def name(self) -> str:
        return self._client.client_name

    def start(self) -> None:
        self._client.add_server_command_listener(self._on_command)
        self._client.add_disconnect_listener(self._disconnected.set)
        self._runner = asyncio.create_task(self._run(), name=f"sendspin-{self.source}")

    async def close(self) -> None:
        if self._runner is not None:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
        await self._end_stream()
        await self._client.disconnect()

    async def report_signal(self, signal: SignalState) -> None:
        """Report ``signal`` once per connection, retrying until the server enables the input."""
        connection = self._connection()
        if connection is None or signal == self._reported:
            return
        try:
            await connection.send_source_signal(signal)
        except RuntimeError:
            # The input stays inactive until the server pairs or approves it.
            self._input_enabled = False
            return
        self._input_enabled = True
        self._reported = signal

    async def create_pairing_token(self) -> str:
        """Replace the pairing PSK and return the token that carries it."""
        psk = generate_psk()
        await self._client.pairing_store.set_pairing_psk(PairingPsk(psk_id=psk_id_for(psk), psk=psk))
        return encode_psk_token(PSKPairingToken(client_id=self.client_id, pairing_psk=psk))

    def snapshot(self) -> dict[str, object]:
        psk = self._client.noise_psk
        connected = self._client.connected
        return {
            "source": self.source,
            "client_id": self.client_id,
            "name": self.name,
            "connection": "connected" if connected else "connecting",
            "paired": connected and psk is not None and psk.category is PskCategory.LONG_TERM,
            "input_enabled": connected and self._input_enabled,
            "streaming": self._stream is not None and not self._stream.done(),
            "signal": self._reported.value if connected and self._reported is not None else None,
        }

    def _connection(self) -> SendspinConnection | None:
        # aiosendspin exposes source signal reporting only on the admitted
        # connection; SendspinClient has no public accessor for it yet.
        connection = self._client._admitted_connection
        return connection if connection is not None and connection.connected else None

    async def _run(self) -> None:
        delay = RECONNECT_INITIAL_SECONDS
        while True:
            self._disconnected.clear()
            try:
                await self._client.connect(self._server_url)
            except Exception as exc:  # The supervisor outlives every connect failure.
                logger.warning("Sendspin source %s cannot reach %s: %s", self.source, self._server_url, exc)
                await asyncio.sleep(delay)
                delay = min(delay * 2, RECONNECT_MAX_SECONDS)
                continue
            delay = RECONNECT_INITIAL_SECONDS
            logger.info("Sendspin source %s connected as %s", self.source, self.client_id)
            await self._disconnected.wait()
            logger.info("Sendspin source %s disconnected", self.source)
            self._reported = None
            self._input_enabled = False
            await self._end_stream()
            await asyncio.sleep(delay)

    def _on_command(self, payload: ServerCommandPayload) -> None:
        if payload.source is None:
            return
        if payload.source.command == "start":
            if self._stream is None or self._stream.done():
                self._stream = asyncio.create_task(self._stream_audio(), name=f"sendspin-stream-{self.source}")
        elif self._stream is not None:
            self._stream.cancel()

    async def _end_stream(self) -> None:
        if self._stream is not None:
            self._stream.cancel()
            await asyncio.gather(self._stream, return_exceptions=True)
            self._stream = None

    async def _stream_audio(self) -> None:
        try:
            feed = self._open_feed(self.source)
        except LookupError as exc:
            logger.warning("Sendspin source %s cannot stream: %s", self.source, exc)
            return
        try:
            capture = self._client.create_source_capture(CAPTURE_FORMAT)
            await capture.start()
            logger.info("Sendspin source %s streaming", self.source)
            clock = CaptureClock()
            try:
                while True:
                    packet = await feed.get()
                    timestamp = clock.timestamp(packet.sequence, packet.arrival_us)
                    await capture.feed(packet.payload or self._silence, timestamp)
            finally:
                with contextlib.suppress(RuntimeError):
                    await capture.stop()
                logger.info("Sendspin source %s stopped streaming (%d packets dropped)", self.source, feed.dropped)
        except RuntimeError as exc:
            # The connection ended or the server withdrew the input mid-stream.
            logger.info("Sendspin source %s stream ended: %s", self.source, exc)
        finally:
            feed.close()
