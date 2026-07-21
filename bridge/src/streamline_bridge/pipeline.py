"""Composition of one source's playout and HTTP client fan-out."""

from __future__ import annotations

import threading

from streamline_bridge.fanout import ClientFanout, ClientStream
from streamline_bridge.levels import AudioLevels
from streamline_bridge.packet_tap import PacketSink, PacketTapFanout
from streamline_bridge.playout import Clock, PlayoutBuffer, PlayoutWorker
from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat


class AudioPipeline:
    """One independently paced source pipeline."""

    def __init__(
        self,
        max_client_chunks: int,
        playout_buffer_seconds: float,
        max_repeat_conceal_packets: int,
        max_outage_silence_seconds: float,
        pcm_format: PcmFormat = DEFAULT_FORMAT,
        clock: Clock | None = None,
        start_worker: bool = True,
    ) -> None:
        self.playout = PlayoutBuffer(
            playout_buffer_seconds,
            max_repeat_conceal_packets,
            max_outage_silence_seconds,
            pcm_format,
            clock,
        )
        now = clock.time if clock is not None else None
        self.clients = ClientFanout(max_client_chunks, now=now) if now is not None else ClientFanout(max_client_chunks)
        self.packet_taps = PacketTapFanout()
        self.levels = AudioLevels()
        self._worker: threading.Thread | None = None
        if start_worker:
            self._worker = threading.Thread(
                target=PlayoutWorker(self.playout, self.clients.publish, clock).run,
                name="playout-worker",
                daemon=True,
            )
            self._worker.start()

    def close(self) -> None:
        """Stop the playout worker and end every client stream."""
        self.playout.close()
        if self._worker is not None:
            self._worker.join()
            self._worker = None
        self.clients.close()

    def reset_source_session(self) -> None:
        self.playout.reset_source_session()
        self.levels.reset()

    def ingest(self, seq: int, payload: bytes) -> bool:
        """Admit one packet; ``False`` demands the producer's disconnect."""
        if not self.playout.ingest(seq, payload):
            return False
        self.levels.update(payload)
        self.packet_taps.publish(seq, payload)
        return True

    def note_tcp_connect(self) -> None:
        self.playout.note_tcp_connect()

    def note_tcp_disconnect(self) -> None:
        self.playout.note_tcp_disconnect()

    def note_tcp_error(self) -> None:
        self.playout.note_tcp_error()

    def snapshot(self) -> dict[str, object]:
        data = self.playout.snapshot()
        data.update(self.clients.snapshot())
        data["levels"] = self.levels.snapshot()
        return data

    def register_client(self, remote_addr: str, path: str) -> ClientStream:
        return self.clients.register(remote_addr, path)

    def unregister_client(self, client_id: int) -> None:
        self.clients.unregister(client_id)

    def record_client_write(self, client_id: int, byte_count: int, chunk_count: int) -> None:
        self.clients.record_write(client_id, byte_count, chunk_count)

    def register_packet_tap(self, sink: PacketSink) -> int:
        return self.packet_taps.register(sink)

    def unregister_packet_tap(self, sink_id: int) -> None:
        self.packet_taps.unregister(sink_id)
