"""Reconstruct one source's packet timeline on a bounded writer thread."""

from __future__ import annotations

import contextlib
import queue
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING

from streamline_bridge.playout import seq_distance
from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.recording.model import (
    RecordingError,
    RecordingLimits,
    RecordingManifest,
    RecordingSnapshot,
    RecordingState,
    isoformat,
    utc_now,
)
from streamline_bridge.recording.wav import WavRecordingFile

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from streamline_bridge.recording.store import RecordingPaths, RecordingStore

SPACE_CHECK_INTERVAL_BYTES = 4 * 1024 * 1024
SILENCE_BATCH_PACKETS = 256


@dataclass(frozen=True)
class Packet:
    sequence: int
    payload: bytes


class RecordingSession:
    """Reconstruct one source timeline on a bounded writer thread."""

    def __init__(
        self,
        paths: RecordingPaths,
        title: str,
        source: str,
        store: RecordingStore,
        limits: RecordingLimits,
        on_finished: Callable[[str], None],
        pcm_format: PcmFormat = DEFAULT_FORMAT,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self.id = paths.recording_id
        self.title = title
        self.source = source
        self._paths = paths
        self._store = store
        self._limits = limits
        self._on_finished = on_finished
        self._format = pcm_format
        self._now = now
        self._created_at = isoformat(now())
        self._audio_started_at: str | None = None
        self._finished_at: str | None = None
        self._state: RecordingState = "waiting-for-audio"
        self._frames = 0
        self._gap_packets = 0
        self._duplicate_packets = 0
        self._error: str | None = None
        self._queue: queue.Queue[Packet] = queue.Queue(limits.queue_chunks)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._output = WavRecordingFile(store, paths, pcm_format)
        self._thread = threading.Thread(target=self._run, name=f"recording-{self.id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def discard_unstarted(self) -> None:
        self._output.discard()

    def offer(self, sequence: int, payload: bytes) -> None:
        with self._lock:
            accepting = self._state in {"waiting-for-audio", "recording"} and not self._stop.is_set()
        if not accepting:
            return
        try:
            self._queue.put_nowait(Packet(sequence, payload))
        except queue.Full:
            self.interrupt(
                "The recording writer could not keep up. The partial WAV is available; retry on faster storage."
            )

    def stop(self) -> RecordingSnapshot:
        with self._lock:
            if self._state in {"waiting-for-audio", "recording"}:
                self._state = "finalizing"
            self._stop.set()
        self._thread.join()
        return self.snapshot()

    def interrupt(self, message: str) -> None:
        with self._lock:
            if self._stop.is_set():
                return
            self._error = message
            self._state = "finalizing"
            self._stop.set()

    def snapshot(self) -> RecordingSnapshot:
        with self._lock:
            return self.snapshot_unlocked()

    def _run(self) -> None:
        output = self._output
        try:
            self._consume(output)
        except (OSError, RecordingError, ValueError) as exc:
            self._set_storage_error(exc)
        finally:
            self._finalize_output(output)
            self._on_finished(self.id)

    def _consume(self, output: WavRecordingFile) -> None:
        previous_sequence: int | None = None
        bytes_since_space_check = 0
        while not self._stop.is_set() or not self._queue.empty():
            try:
                packet = self._queue.get(timeout=0.1)
            except queue.Empty:
                continue
            gap_packets = 0
            if previous_sequence is not None:
                distance = seq_distance(previous_sequence, packet.sequence)
                if distance == 0:
                    with self._lock:
                        self._duplicate_packets += 1
                    continue
                if distance < 0:
                    self.interrupt(
                        "The source timeline moved backwards, likely after a device restart. Start a new recording."
                    )
                    break
                gap_packets = distance - 1
                if gap_packets > self._max_gap_packets:
                    self.interrupt("The source paused for more than five minutes. Start a new recording.")
                    break
            added_packets = gap_packets + 1
            if self._frames + added_packets * self._format.frames_per_packet > self._max_frames:
                self.interrupt("The four-hour recording limit was reached. Start a new recording.")
                break
            added_bytes = added_packets * self._format.payload_bytes
            bytes_since_space_check += added_bytes
            if bytes_since_space_check >= SPACE_CHECK_INTERVAL_BYTES:
                bytes_since_space_check = 0
                if self._store.free_bytes() < self._limits.min_free_bytes:
                    self.interrupt("Recording stopped to keep 256 MiB of storage free. Download or delete files.")
                    break
            if gap_packets:
                self._append_silence(output, gap_packets)
            output.append(packet.payload)
            previous_sequence = packet.sequence
            with self._lock:
                if self._audio_started_at is None:
                    self._audio_started_at = isoformat(self._now())
                self._state = "recording"
                self._gap_packets += gap_packets
                self._frames += added_packets * self._format.frames_per_packet

    def _set_storage_error(self, exc: Exception) -> None:
        with self._lock:
            self._error = f"Recording storage failed: {exc}. Check the recording directory and retry."

    def _finalize_output(self, output: WavRecordingFile) -> None:
        try:
            self._finish(output)
        except (OSError, RecordingError, ValueError) as exc:
            self._set_storage_error(exc)
            with contextlib.suppress(OSError):
                output.close_for_recovery()
            with self._lock:
                self._state = "interrupted"
                self._finished_at = isoformat(self._now())

    @property
    def _max_gap_packets(self) -> int:
        return self._limits.max_gap_seconds * self._format.rate // self._format.frames_per_packet

    @property
    def _max_frames(self) -> int:
        return self._limits.max_duration_seconds * self._format.rate

    def _append_silence(self, output: WavRecordingFile, packets: int) -> None:
        while packets:
            batch_packets = min(packets, SILENCE_BATCH_PACKETS)
            output.append(bytes(self._format.payload_bytes * batch_packets))
            packets -= batch_packets

    def _finish(self, output: WavRecordingFile) -> None:
        with self._lock:
            error = self._error
        if output.data_bytes == 0:
            output.discard()
            state: RecordingState = "empty"
            file_name = ""
            frames = 0
        else:
            output.finalize()
            frame_bytes = self._format.channels * self._format.bits // 8
            frames = output.data_bytes // frame_bytes
            state = "interrupted" if error else "complete"
            file_name = self._paths.wav.name
        finished_at = isoformat(self._now())
        with self._lock:
            self._state = state
            self._finished_at = finished_at
            self._frames = frames
            snapshot = self.snapshot_unlocked()
        if frames:
            self._store.save_manifest(
                RecordingManifest(
                    1,
                    self.id,
                    self.title,
                    self.source,
                    state,
                    self._created_at,
                    snapshot["audio_started_at"],
                    finished_at,
                    self._format.rate,
                    self._format.channels,
                    self._format.bits,
                    frames,
                    snapshot["bytes"],
                    snapshot["duration_seconds"],
                    snapshot["gap_packets"],
                    snapshot["duplicate_packets"],
                    error,
                    file_name,
                )
            )

    def snapshot_unlocked(self) -> RecordingSnapshot:
        frames = self._frames
        return {
            "id": self.id,
            "title": self.title,
            "source": self.source,
            "state": self._state,
            "created_at": self._created_at,
            "audio_started_at": self._audio_started_at,
            "finished_at": self._finished_at,
            "frames": frames,
            "bytes": frames * self._format.channels * self._format.bits // 8,
            "duration_seconds": frames / self._format.rate,
            "gap_packets": self._gap_packets,
            "duplicate_packets": self._duplicate_packets,
            "error": self._error,
            "file_name": self._paths.wav.name if self._store.has_file(self.id) else None,
        }
