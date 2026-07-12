"""Lossless packet-timeline recording and durable WAV storage."""

from __future__ import annotations

import contextlib
import json
import os
import queue
import re
import secrets
import shutil
import struct
import threading
import unicodedata
import wave
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, TypedDict

from streamline_bridge.playout import seq_distance
from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.sources import SourceSelectionError

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.sources import Source, SourceRegistry

RecordingState = Literal[
    "waiting-for-audio",
    "recording",
    "finalizing",
    "complete",
    "interrupted",
    "empty",
]

WAV_HEADER_BYTES = 44
WAV_MAX_DATA_BYTES = 0xFFFFFFFF - 36
DEFAULT_MAX_DURATION_SECONDS = 4 * 60 * 60
DEFAULT_MAX_GAP_SECONDS = 5 * 60
DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024
DEFAULT_QUEUE_CHUNKS = 1024
MAX_TITLE_CHARS = 80
SPACE_CHECK_INTERVAL_BYTES = 4 * 1024 * 1024
ID_PATTERN = re.compile(r"^[a-zA-Z0-9-]+$")


class RecordingError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class RecordingSnapshot(TypedDict):
    id: str
    title: str
    source: str
    state: RecordingState
    created_at: str
    audio_started_at: str | None
    finished_at: str | None
    frames: int
    bytes: int
    duration_seconds: float
    gap_packets: int
    duplicate_packets: int
    error: str | None
    file_name: str | None


@dataclass(frozen=True)
class RecordingLimits:
    max_duration_seconds: int = DEFAULT_MAX_DURATION_SECONDS
    max_gap_seconds: int = DEFAULT_MAX_GAP_SECONDS
    min_free_bytes: int = DEFAULT_MIN_FREE_BYTES
    queue_chunks: int = DEFAULT_QUEUE_CHUNKS
    max_title_chars: int = MAX_TITLE_CHARS


DEFAULT_RECORDING_LIMITS = RecordingLimits()


def recording_capabilities(enabled: bool, limits: RecordingLimits = DEFAULT_RECORDING_LIMITS) -> dict[str, object]:
    return {
        "enabled": enabled,
        "format": {
            "container": "wav",
            "codec": "pcm_s16le",
            "sample_rate": DEFAULT_FORMAT.rate,
            "channels": DEFAULT_FORMAT.channels,
            "bits_per_sample": DEFAULT_FORMAT.bits,
            "bytes_per_second": DEFAULT_FORMAT.rate * DEFAULT_FORMAT.channels * DEFAULT_FORMAT.bits // 8,
        },
        "limits": asdict(limits),
    }


@dataclass(frozen=True)
class RecordingPaths:
    recording_id: str
    part: Path
    wav: Path
    manifest: Path
    manifest_part: Path


@dataclass
class RecordingManifest:
    schema_version: int
    id: str
    title: str
    source: str
    state: RecordingState
    created_at: str
    audio_started_at: str | None
    finished_at: str | None
    sample_rate: int
    channels: int
    bits_per_sample: int
    frames: int
    bytes: int
    duration_seconds: float
    gap_packets: int
    duplicate_packets: int
    error: str | None
    file_name: str

    def snapshot(self) -> RecordingSnapshot:
        return {
            "id": self.id,
            "title": self.title,
            "source": self.source,
            "state": self.state,
            "created_at": self.created_at,
            "audio_started_at": self.audio_started_at,
            "finished_at": self.finished_at,
            "frames": self.frames,
            "bytes": self.bytes,
            "duration_seconds": self.duration_seconds,
            "gap_packets": self.gap_packets,
            "duplicate_packets": self.duplicate_packets,
            "error": self.error,
            "file_name": self.file_name,
        }


def utc_now() -> datetime:
    return datetime.now(UTC)


def isoformat(value: datetime) -> str:
    return value.isoformat(timespec="seconds").replace("+00:00", "Z")


def wav_header(data_bytes: int, pcm_format: PcmFormat = DEFAULT_FORMAT) -> bytes:
    if data_bytes < 0 or data_bytes > WAV_MAX_DATA_BYTES:
        raise ValueError("WAV data size is outside the RIFF limit")
    block_align = pcm_format.channels * pcm_format.bits // 8
    byte_rate = pcm_format.rate * block_align
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", data_bytes + 36),
            b"WAVEfmt ",
            struct.pack(
                "<IHHIIHH", 16, 1, pcm_format.channels, pcm_format.rate, byte_rate, block_align, pcm_format.bits
            ),
            b"data",
            struct.pack("<I", data_bytes),
        )
    )


class WavRecordingFile:
    """Stream PCM to a repairable part file and atomically publish it."""

    def __init__(self, paths: RecordingPaths, pcm_format: PcmFormat = DEFAULT_FORMAT) -> None:
        self.paths = paths
        self._format = pcm_format
        self._file = paths.part.open("w+b")
        self._file.write(wav_header(0, pcm_format))
        self.data_bytes = 0

    def append(self, payload: bytes) -> None:
        if len(payload) % (self._format.channels * self._format.bits // 8):
            raise ValueError("PCM payload is not frame-aligned")
        if self.data_bytes + len(payload) > WAV_MAX_DATA_BYTES:
            raise RecordingError("duration-limit", "The WAV size limit was reached. Start a new recording.")
        self._file.write(payload)
        self.data_bytes += len(payload)

    def finalize(self) -> Path:
        self._file.seek(0)
        self._file.write(wav_header(self.data_bytes, self._format))
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
        os.replace(self.paths.part, self.paths.wav)
        _sync_directory(self.paths.wav.parent)
        return self.paths.wav

    def discard(self) -> None:
        self._file.close()
        self.paths.part.unlink(missing_ok=True)

    def close_for_recovery(self) -> None:
        if self._file.closed:
            return
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()


class RecordingStore:
    """Own the configured recording directory and its artifact lifecycle."""

    def __init__(
        self,
        root: Path,
        pcm_format: PcmFormat = DEFAULT_FORMAT,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self.root = root
        self._format = pcm_format
        self._now = now
        root.mkdir(parents=True, exist_ok=True)
        if not root.is_dir() or not os.access(root, os.W_OK):
            raise RecordingError("storage-unavailable", f"Recording directory is not writable: {root}")
        self.recover()

    def allocate(self, title: str) -> RecordingPaths:
        stamp = self._now().astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
        slug = _slug(title)
        recording_id = f"{stamp}-{slug}-{secrets.token_hex(3)}"
        return self.paths(recording_id)

    def paths(self, recording_id: str) -> RecordingPaths:
        _validate_id(recording_id)
        return RecordingPaths(
            recording_id,
            self.root / f".{recording_id}.wav.part",
            self.root / f"{recording_id}.wav",
            self.root / f"{recording_id}.json",
            self.root / f".{recording_id}.json.part",
        )

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free

    def save_manifest(self, manifest: RecordingManifest) -> None:
        paths = self.paths(manifest.id)
        with paths.manifest_part.open("w", encoding="utf-8") as output:
            json.dump(asdict(manifest), output, ensure_ascii=False, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(paths.manifest_part, paths.manifest)
        _sync_directory(self.root)

    def list(self) -> list[RecordingSnapshot]:
        recordings: list[RecordingSnapshot] = []
        for manifest_path in sorted(self.root.glob("*.json"), reverse=True):
            try:
                data = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest = RecordingManifest(**data)
            except (OSError, json.JSONDecodeError, TypeError):
                continue
            if self.paths(manifest.id).wav.is_file():
                recordings.append(manifest.snapshot())
        return recordings

    def file(self, recording_id: str) -> Path:
        path = self.paths(recording_id).wav
        if not path.is_file():
            raise RecordingError("not-found", "Recording not found. Refresh the recording list.")
        return path

    def delete(self, recording_id: str) -> None:
        paths = self.paths(recording_id)
        if not paths.wav.is_file():
            raise RecordingError("not-found", "Recording not found. Refresh the recording list.")
        paths.wav.unlink()
        paths.manifest.unlink(missing_ok=True)
        _sync_directory(self.root)

    def recover(self) -> None:
        for part in self.root.glob(".*.wav.part"):
            recording_id = part.name[1:-9]
            try:
                paths = self.paths(recording_id)
                size = part.stat().st_size
                data_bytes = max(0, size - WAV_HEADER_BYTES)
                frame_bytes = self._format.channels * self._format.bits // 8
                data_bytes -= data_bytes % frame_bytes
                if data_bytes == 0:
                    part.unlink(missing_ok=True)
                    continue
                with part.open("r+b") as output:
                    output.truncate(WAV_HEADER_BYTES + data_bytes)
                    output.seek(0)
                    output.write(wav_header(data_bytes, self._format))
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(part, paths.wav)
                frames = data_bytes // frame_bytes
                finished = isoformat(self._now())
                self.save_manifest(
                    RecordingManifest(
                        1,
                        recording_id,
                        _title_from_id(recording_id),
                        "unknown",
                        "interrupted",
                        finished,
                        None,
                        finished,
                        self._format.rate,
                        self._format.channels,
                        self._format.bits,
                        frames,
                        data_bytes,
                        frames / self._format.rate,
                        0,
                        0,
                        "The bridge stopped before this recording finalized. Check the audio before using it.",
                        paths.wav.name,
                    )
                )
            except (OSError, RecordingError, ValueError):
                continue
        for wav_path in self.root.glob("*.wav"):
            recording_id = wav_path.stem
            try:
                paths = self.paths(recording_id)
                if paths.manifest.is_file():
                    continue
                with wave.open(str(wav_path), "rb") as recording:
                    if (
                        recording.getframerate(),
                        recording.getnchannels(),
                        recording.getsampwidth() * 8,
                    ) != (self._format.rate, self._format.channels, self._format.bits):
                        continue
                    frames = recording.getnframes()
                finished = isoformat(datetime.fromtimestamp(wav_path.stat().st_mtime, UTC))
                self.save_manifest(
                    RecordingManifest(
                        1,
                        recording_id,
                        _title_from_id(recording_id),
                        "unknown",
                        "interrupted",
                        finished,
                        None,
                        finished,
                        self._format.rate,
                        self._format.channels,
                        self._format.bits,
                        frames,
                        frames * self._format.channels * self._format.bits // 8,
                        frames / self._format.rate,
                        0,
                        0,
                        "The recording manifest was missing. Check the audio before using it.",
                        wav_path.name,
                    )
                )
            except (OSError, RecordingError, ValueError, wave.Error):
                continue


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
        self._thread = threading.Thread(target=self._run, name=f"recording-{self.id}", daemon=True)

    def start(self) -> None:
        self._thread.start()

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
                "file_name": self._paths.wav.name if self._paths.wav.is_file() else None,
            }

    def _run(self) -> None:
        output: WavRecordingFile | None = None
        try:
            output = WavRecordingFile(self._paths, self._format)
            self._consume(output)
        except (OSError, RecordingError, ValueError) as exc:
            self._set_storage_error(exc)
        finally:
            if output is None:
                self._mark_unpublished_failure()
            else:
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

    def _mark_unpublished_failure(self) -> None:
        with self._lock:
            self._state = "interrupted"
            self._finished_at = isoformat(self._now())

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
        silence = bytes(self._format.payload_bytes)
        for _ in range(packets):
            output.append(silence)

    def _finish(self, output: WavRecordingFile) -> None:
        with self._lock:
            frames = self._frames
            error = self._error
        if frames == 0:
            output.discard()
            state: RecordingState = "empty"
            file_name = ""
        else:
            output.finalize()
            state = "interrupted" if error else "complete"
            file_name = self._paths.wav.name
        finished_at = isoformat(self._now())
        with self._lock:
            self._state = state
            self._finished_at = finished_at
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
            "file_name": self._paths.wav.name if self._paths.wav.is_file() else None,
        }


@dataclass
class ActiveRecording:
    source: Source[AudioPipeline]
    tap_id: int
    session: RecordingSession


class RecordingService:
    """Coordinate source retention, packet taps, sessions, and storage."""

    def __init__(
        self,
        sources: SourceRegistry[AudioPipeline],
        store: RecordingStore,
        limits: RecordingLimits = DEFAULT_RECORDING_LIMITS,
    ) -> None:
        self._sources = sources
        self._store = store
        self._limits = limits
        self._lock = threading.Lock()
        self._active: dict[str, ActiveRecording] = {}

    def capabilities(self) -> dict[str, object]:
        return recording_capabilities(True, self._limits)

    def list(self) -> dict[str, object]:
        with self._lock:
            active = [binding.session.snapshot() for binding in self._active.values()]
        return {
            "active": sorted(active, key=lambda item: item["created_at"], reverse=True),
            "saved": self._store.list(),
            "storage": {"free_bytes": self._store.free_bytes()},
        }

    def start(self, source_key: str, title: str) -> RecordingSnapshot:
        title = _validate_title(title, self._limits.max_title_chars)
        if self._store.free_bytes() < self._limits.min_free_bytes:
            raise RecordingError("storage-full", "Recording needs at least 256 MiB free. Delete files and retry.")
        try:
            source = self._sources.select(source_key)
        except SourceSelectionError as exc:
            raise RecordingError("invalid-source", exc.message) from exc
        with self._lock:
            if any(binding.source is source for binding in self._active.values()):
                raise RecordingError(
                    "source-busy", "This source is already recording. Stop it before starting another."
                )
            paths = self._store.allocate(title)
            session = RecordingSession(paths, title, source.key, self._store, self._limits, self._session_finished)
            self._sources.retain_recording(source)
            try:
                tap_id = source.hub.register_packet_tap(session.offer)
            except Exception:
                self._sources.release_recording(source)
                raise
            self._active[session.id] = ActiveRecording(source, tap_id, session)
            session.start()
            return session.snapshot()

    def stop(self, recording_id: str) -> RecordingSnapshot:
        binding = self._detach(recording_id)
        if binding is None:
            raise RecordingError("not-active", "This recording is not active. Refresh the recording list.")
        return binding.session.stop()

    def file(self, recording_id: str) -> Path:
        return self._store.file(recording_id)

    def delete(self, recording_id: str) -> None:
        with self._lock:
            if recording_id in self._active:
                raise RecordingError("recording-active", "Stop the recording before deleting it.")
        self._store.delete(recording_id)

    def shutdown(self) -> None:
        with self._lock:
            recording_ids = tuple(self._active)
        for recording_id in recording_ids:
            binding = self._detach(recording_id)
            if binding is not None:
                binding.session.stop()

    def _session_finished(self, recording_id: str) -> None:
        self._detach(recording_id)

    def _detach(self, recording_id: str) -> ActiveRecording | None:
        with self._lock:
            binding = self._active.pop(recording_id, None)
        if binding is not None:
            binding.source.hub.unregister_packet_tap(binding.tap_id)
            self._sources.release_recording(binding.source)
        return binding


def _validate_title(title: str, max_chars: int) -> str:
    title = " ".join(title.split())
    if not title:
        raise RecordingError("invalid-title", "Enter a recording title.")
    if len(title) > max_chars:
        raise RecordingError("invalid-title", f"Recording titles must be {max_chars} characters or fewer.")
    return title


def _slug(title: str) -> str:
    normalized = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")[:48] or "recording"


def _validate_id(recording_id: str) -> None:
    if not ID_PATTERN.fullmatch(recording_id):
        raise RecordingError("not-found", "Recording not found. Refresh the recording list.")


def _title_from_id(recording_id: str) -> str:
    parts = recording_id.split("-")
    return " ".join(parts[1:-1]).title() or "Recovered recording"


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
