"""Publish each device's bridge source to Music Assistant from a dedicated event loop."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import TYPE_CHECKING

from aiosendspin.clock import RawMonotonicClock
from aiosendspin.models.types import SignalState

from streamline_bridge.sendspin.identity import SendspinStateError
from streamline_bridge.sendspin.packet_feed import PacketFeed
from streamline_bridge.sendspin.publisher import SendspinPublisher, build_client
from streamline_bridge.sources import SourceSelectionError

if TYPE_CHECKING:
    from collections.abc import Mapping

    from aiosendspin.clock import Clock

    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.sendspin.identity import SendspinIdentityStore
    from streamline_bridge.sources import SourceRegistry

logger = logging.getLogger(__name__)

RECONCILE_SECONDS = 0.5
CALL_TIMEOUT_SECONDS = 10.0
FEED_CAPACITY_PACKETS = 188  # One second of 256-frame packets at 48 kHz.


def line_signal(source: Mapping[str, object]) -> SignalState:
    """Return the line-in signal of one registry source snapshot."""
    lifecycle = source["lifecycle"]
    connected = isinstance(lifecycle, dict) and lifecycle.get("state") == "connected"
    return SignalState.PRESENT if connected and source.get("signal") == "present" else SignalState.ABSENT


class SendspinService:
    """Keep one Sendspin publisher per identified registry source on the service's own loop.

    HTTP handlers run on other threads: they read a snapshot the loop publishes
    after each reconcile, and submit pairing-token requests to the loop.
    """

    def __init__(
        self,
        sources: SourceRegistry[AudioPipeline],
        server_url: str,
        identities: SendspinIdentityStore,
        software_version: str,
        clock: Clock | None = None,
    ) -> None:
        self._sources = sources
        self._server_url = server_url
        self._identities = identities
        self._software_version = software_version
        self._clock = clock or RawMonotonicClock()
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, name="sendspin", daemon=True)
        self._publishers: dict[str, SendspinPublisher] = {}
        self._unpublishable: set[str] = set()
        self._reconciler: asyncio.Task[None] | None = None
        self._snapshot_lock = threading.Lock()
        self._snapshot: list[dict[str, object]] = []

    def start(self) -> None:
        self._thread.start()
        asyncio.run_coroutine_threadsafe(self._begin(), self._loop).result(CALL_TIMEOUT_SECONDS)

    def close(self) -> None:
        """Disconnect every publisher and stop the loop; never raises on a slow server."""
        if not self._thread.is_alive():
            return
        future = asyncio.run_coroutine_threadsafe(self._shutdown(), self._loop)
        try:
            future.result(CALL_TIMEOUT_SECONDS)
        except TimeoutError:
            future.cancel()
            logger.warning("Sendspin publishers did not close within %s seconds", CALL_TIMEOUT_SECONDS)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join()
        self._loop.close()

    def snapshot(self) -> dict[str, object]:
        with self._snapshot_lock:
            sources = list(self._snapshot)
        return {"enabled": True, "server_url": self._server_url, "sources": sources}

    def create_pairing_token(self, source: str) -> dict[str, str]:
        """Return a fresh pairing token for a published source.

        Raises ``LookupError`` for an unpublished source and ``TimeoutError``
        when the loop does not answer in time; the pairing secret may then have
        changed, so the caller must request another token.
        """
        future = asyncio.run_coroutine_threadsafe(self._create_pairing_token(source), self._loop)
        try:
            return future.result(CALL_TIMEOUT_SECONDS)
        except TimeoutError:
            future.cancel()
            raise

    async def _begin(self) -> None:
        self._reconciler = asyncio.create_task(self._reconcile_forever(), name="sendspin-reconcile")

    async def _shutdown(self) -> None:
        if self._reconciler is not None:
            self._reconciler.cancel()
            await asyncio.gather(self._reconciler, return_exceptions=True)
        publishers = tuple(self._publishers.values())
        self._publishers.clear()
        await asyncio.gather(*(publisher.close() for publisher in publishers), return_exceptions=True)

    async def _create_pairing_token(self, source: str) -> dict[str, str]:
        publisher = self._publishers.get(source)
        if publisher is None:
            raise LookupError(f"source {source} is not published to Music Assistant")
        token = await publisher.create_pairing_token()
        return {"source": source, "client_id": publisher.client_id, "token": token}

    async def _reconcile_forever(self) -> None:
        while True:
            try:
                await self._reconcile()
            except Exception:
                # One failed pass must not end publishing; the next pass retries.
                logger.exception("Sendspin reconcile pass failed")
            await asyncio.sleep(RECONCILE_SECONDS)

    async def _reconcile(self) -> None:
        wanted = {key: line_signal(source) for key, source in self._sources.identified_snapshot().items()}
        retired = [self._publishers.pop(key) for key in self._publishers.keys() - wanted.keys()]
        await asyncio.gather(*(publisher.close() for publisher in retired), return_exceptions=True)
        for key in wanted.keys() - self._publishers.keys():
            publisher = await self._publish(key)
            if publisher is not None:
                self._publishers[key] = publisher
        for key, publisher in self._publishers.items():
            try:
                await publisher.report_signal(wanted[key])
            except Exception:
                logger.exception("Sendspin source %s signal report failed", key)
        snapshot = [publisher.snapshot() for _, publisher in sorted(self._publishers.items())]
        with self._snapshot_lock:
            self._snapshot = snapshot

    async def _publish(self, source: str) -> SendspinPublisher | None:
        try:
            identity = self._identities.identity(source)
            store = await self._identities.pairing_store(source)
        except (OSError, SendspinStateError) as exc:
            if source not in self._unpublishable:
                logger.error("Sendspin cannot publish source %s: %s", source, exc)
                self._unpublishable.add(source)
            return None
        self._unpublishable.discard(source)
        client = build_client(identity, f"StreamLine {source}", store, self._clock, self._software_version)
        publisher = SendspinPublisher(source, self._server_url, client, self._open_feed)
        publisher.start()
        return publisher

    def _open_feed(self, source: str) -> PacketFeed:
        try:
            lease = self._sources.lease_sendspin(source)
        except SourceSelectionError as exc:
            raise LookupError(exc.message) from exc
        return PacketFeed(lease, self._loop, self._clock, FEED_CAPACITY_PACKETS)
