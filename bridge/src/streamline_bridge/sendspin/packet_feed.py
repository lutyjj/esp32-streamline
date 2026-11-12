"""Deliver one leased source's accepted packets to an asyncio consumer."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, NamedTuple

if TYPE_CHECKING:
    from aiosendspin.clock import Clock

    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.sources import SourceLease


class Packet(NamedTuple):
    sequence: int
    arrival_us: int
    payload: bytes


class PacketFeed:
    """Hold a Sendspin lease on one source and queue its packets on an event loop.

    The packet tap runs on the producer's thread and never blocks it. A consumer
    that falls ``capacity`` packets behind loses the oldest ones first.
    """

    def __init__(
        self,
        lease: SourceLease[AudioPipeline],
        loop: asyncio.AbstractEventLoop,
        clock: Clock,
        capacity: int,
    ) -> None:
        self._lease = lease
        self._loop = loop
        self._clock = clock
        self._queue: asyncio.Queue[Packet] = asyncio.Queue(capacity)
        self.dropped = 0
        self._tap = lease.hub.register_packet_tap(self._on_packet)

    async def get(self) -> Packet:
        return await self._queue.get()

    def close(self) -> None:
        self._lease.hub.unregister_packet_tap(self._tap)
        self._lease.close()

    def _on_packet(self, sequence: int, payload: bytes) -> None:
        self._loop.call_soon_threadsafe(self._enqueue, Packet(sequence, self._clock.now_us(), payload))

    def _enqueue(self, packet: Packet) -> None:
        if self._queue.full():
            self._queue.get_nowait()
            self.dropped += 1
        self._queue.put_nowait(packet)
