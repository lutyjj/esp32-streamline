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
from tenacity import before_sleep_log, retry, wait_exponential

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
# Bounds the goodbye handshake so an unresponsive server cannot hold shutdown.
DISCONNECT_TIMEOUT_SECONDS = 2.0


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
        self._closing = False

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
        self._closing = True
        if self._runner is not None:
            self._runner.cancel()
            await asyncio.gather(self._runner, return_exceptions=True)
        await self._end_stream()
        try:
            async with asyncio.timeout(DISCONNECT_TIMEOUT_SECONDS):
                await self._client.disconnect()
        except TimeoutError:
            logger.warning(
                "Sendspin server did not answer source %s's goodbye within %s s",
                self.source,
                DISCONNECT_TIMEOUT_SECONDS,
            )
        except OSError as exc:
            logger.warning("Sendspin source %s closed without a clean goodbye: %s", self.source, exc)

    async def report_signal(self, signal: SignalState) -> None:
        """Report ``signal`` whenever it changes or the server re-enables the input."""
        connection = self._connection()
        if connection is None or not _source_input_enabled(connection):
            # A server that enables the input again resets its signal state.
            self._reported = None
            return
        if signal == self._reported:
            return
        try:
            await connection.send_source_signal(signal)
        except (RuntimeError, ConnectionError) as exc:
            logger.debug("Sendspin source %s signal not reported: %s", self.source, exc)
            return
        self._reported = signal

    async def create_pairing_token(self) -> str:
        """Replace the pairing PSK and return the token that carries it."""
        psk = generate_psk()
        await self._client.pairing_store.set_pairing_psk(PairingPsk(psk_id=psk_id_for(psk), psk=psk))
        return encode_psk_token(PSKPairingToken(client_id=self.client_id, pairing_psk=psk))

    def snapshot(self) -> dict[str, object]:
        psk = self._client.noise_psk
        connection = self._connection()
        input_enabled = connection is not None and _source_input_enabled(connection)
        return {
            "source": self.source,
            "client_id": self.client_id,
            "name": self.name,
            "connection": "connected" if connection is not None else "connecting",
            "paired": connection is not None and psk is not None and psk.category is PskCategory.LONG_TERM,
            "input_enabled": input_enabled,
            "streaming": self._stream is not None and not self._stream.done(),
            "signal": self._reported.value if input_enabled and self._reported is not None else None,
        }

    def _connection(self) -> SendspinConnection | None:
        # aiosendspin exposes source signal reporting only on the admitted
        # connection; SendspinClient has no public accessor for it yet.
        connection = self._client._admitted_connection
        return connection if connection is not None and connection.connected else None

    async def _run(self) -> None:
        while True:
            self._disconnected.clear()
            await self._connect()
            logger.info("Sendspin source %s connected as %s", self.source, self.client_id)
            await self._disconnected.wait()
            logger.info("Sendspin source %s disconnected", self.source)
            self._reported = None
            await self._end_stream()
            await asyncio.sleep(RECONNECT_INITIAL_SECONDS)

    @retry(
        wait=wait_exponential(min=RECONNECT_INITIAL_SECONDS, max=RECONNECT_MAX_SECONDS),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
    async def _connect(self) -> None:
        """Dial the server until it admits this client; every failure retries."""
        await self._client.connect(self._server_url)

    def _on_command(self, payload: ServerCommandPayload) -> None:
        # aiosendspin forwards a source command only when it takes effect, so a
        # start always opens a new stream, after any stream still tearing down.
        if payload.source is None or self._closing:
            return
        previous = self._stream
        if previous is not None:
            previous.cancel()
        if payload.source.command == "start":
            self._stream = asyncio.create_task(self._restream(previous), name=f"sendspin-stream-{self.source}")

    async def _restream(self, previous: asyncio.Task[None] | None) -> None:
        if previous is not None:
            await asyncio.gather(previous, return_exceptions=True)
        await self._stream_audio()

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
                with contextlib.suppress(RuntimeError, ConnectionError):
                    await capture.stop()
                logger.info("Sendspin source %s stopped streaming (%d packets dropped)", self.source, feed.dropped)
        except (RuntimeError, ConnectionError) as exc:
            # The connection ended or the server withdrew the input mid-stream.
            logger.info("Sendspin source %s stream ended: %s", self.source, exc)
        finally:
            feed.close()


def _source_input_enabled(connection: SendspinConnection) -> bool:
    """Whether the server has activated the source role on this connection."""
    # Role activation has no public accessor in aiosendspin; see _connection.
    return connection._is_role_active("source")
