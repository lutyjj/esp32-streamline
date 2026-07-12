"""Lossless packet-timeline recording and durable WAV storage."""

from __future__ import annotations

import contextlib
import ipaddress
import json
import os
import queue
import re
import secrets
import stat
import struct
import threading
import unicodedata
import wave
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, BinaryIO, Literal, TypedDict, cast

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
MAX_RECORDING_ID_CHARS = 128
MAX_MANIFEST_BYTES = 64 * 1024
MAX_MANIFEST_ERROR_CHARS = 512
MAX_MANIFEST_TIMESTAMP_CHARS = 32
MAX_STORE_SCAN_ENTRIES = 10_000
MAX_LISTED_RECORDINGS = 1_000
SPACE_CHECK_INTERVAL_BYTES = 4 * 1024 * 1024
SILENCE_BATCH_PACKETS = 256
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


@dataclass
class OpenedRecording:
    """One regular recording file opened without following links."""

    name: str
    size: int
    source: BinaryIO


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

    @classmethod
    def from_dict(cls, data: object, pcm_format: PcmFormat = DEFAULT_FORMAT) -> RecordingManifest:
        """Parse an untrusted persisted manifest into the current contract."""
        if not isinstance(data, dict) or set(data) != set(cls.__dataclass_fields__):
            raise ValueError("manifest fields do not match schema version 1")
        if _manifest_int(data, "schema_version") != 1:
            raise ValueError("unsupported manifest schema")
        recording_id = _manifest_string(data, "id", MAX_RECORDING_ID_CHARS)
        _validate_id(recording_id)
        title = _manifest_string(data, "title", MAX_TITLE_CHARS)
        if not title:
            raise ValueError("empty recording title")
        source = _manifest_string(data, "source", 45)
        if source != "unknown":
            ipaddress.IPv4Address(source)
        state = _manifest_string(data, "state", 16)
        if state not in {"complete", "interrupted"}:
            raise ValueError("saved recording has an invalid state")
        saved_state = cast("RecordingState", state)
        created_at = _manifest_timestamp(data, "created_at", required=True)
        audio_started_at = _manifest_timestamp(data, "audio_started_at", required=False)
        finished_at = _manifest_timestamp(data, "finished_at", required=True)
        assert created_at is not None and finished_at is not None
        if (
            _manifest_int(data, "sample_rate") != pcm_format.rate
            or _manifest_int(data, "channels") != pcm_format.channels
            or _manifest_int(data, "bits_per_sample") != pcm_format.bits
        ):
            raise ValueError("recording format does not match the bridge format")
        frames = _manifest_int(data, "frames", minimum=1, maximum=pcm_format.rate * DEFAULT_MAX_DURATION_SECONDS)
        frame_bytes = pcm_format.channels * pcm_format.bits // 8
        expected_bytes = frames * frame_bytes
        if _manifest_int(data, "bytes", minimum=frame_bytes, maximum=WAV_MAX_DATA_BYTES) != expected_bytes:
            raise ValueError("recording byte count does not match its frame count")
        duration = data["duration_seconds"]
        if isinstance(duration, bool) or not isinstance(duration, (int, float)):
            raise ValueError("recording duration must be numeric")
        expected_duration = frames / pcm_format.rate
        if abs(float(duration) - expected_duration) > 1e-6:
            raise ValueError("recording duration does not match its frame count")
        gap_packets = _manifest_int(data, "gap_packets", minimum=0, maximum=0xFFFFFFFF)
        duplicate_packets = _manifest_int(data, "duplicate_packets", minimum=0, maximum=0xFFFFFFFF)
        error_value = data["error"]
        if error_value is not None and (
            not isinstance(error_value, str) or len(error_value) > MAX_MANIFEST_ERROR_CHARS
        ):
            raise ValueError("recording error is invalid")
        file_name = _manifest_string(data, "file_name", MAX_RECORDING_ID_CHARS + 4)
        if file_name != f"{recording_id}.wav":
            raise ValueError("recording file name does not match its id")
        return cls(
            1,
            recording_id,
            title,
            source,
            saved_state,
            created_at,
            audio_started_at,
            finished_at,
            pcm_format.rate,
            pcm_format.channels,
            pcm_format.bits,
            frames,
            expected_bytes,
            expected_duration,
            gap_packets,
            duplicate_packets,
            error_value,
            file_name,
        )

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

    def __init__(self, store: RecordingStore, paths: RecordingPaths, pcm_format: PcmFormat = DEFAULT_FORMAT) -> None:
        self._store = store
        self.paths = paths
        self._format = pcm_format
        self._file = os.fdopen(store.create_part(paths), "w+b")
        self._file.write(wav_header(0, pcm_format))
        self.data_bytes = 0

    def append(self, payload: bytes) -> None:
        if len(payload) % (self._format.channels * self._format.bits // 8):
            raise ValueError("PCM payload is not frame-aligned")
        if self.data_bytes + len(payload) > WAV_MAX_DATA_BYTES:
            raise RecordingError("duration-limit", "The WAV size limit was reached. Start a new recording.")
        written = self._file.write(payload)
        self.data_bytes += written
        if written != len(payload):
            raise OSError(f"short recording write: {written} of {len(payload)} bytes")

    def finalize(self) -> Path:
        self._file.flush()
        file_bytes = self._file.seek(0, os.SEEK_END)
        frame_bytes = self._format.channels * self._format.bits // 8
        self.data_bytes = max(0, file_bytes - WAV_HEADER_BYTES)
        self.data_bytes -= self.data_bytes % frame_bytes
        self._file.truncate(WAV_HEADER_BYTES + self.data_bytes)
        self._file.seek(0)
        self._file.write(wav_header(self.data_bytes, self._format))
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()
        self._store.publish_part(self.paths)
        return self.paths.wav

    def discard(self) -> None:
        self._file.close()
        self._store.discard_part(self.paths)

    def close_for_recovery(self) -> None:
        if self._file.closed:
            return
        self._file.flush()
        os.fsync(self._file.fileno())
        self._file.close()


class RecordingStore:
    """Own one pinned recording directory and its artifact lifecycle."""

    def __init__(
        self,
        root: Path,
        pcm_format: PcmFormat = DEFAULT_FORMAT,
        now: Callable[[], datetime] = utc_now,
    ) -> None:
        self.root = root
        self._format = pcm_format
        self._now = now
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        flags = os.O_RDONLY | _os_flag("O_DIRECTORY") | _os_flag("O_NOFOLLOW") | _os_flag("O_CLOEXEC")
        try:
            self._directory = os.open(root, flags)
        except OSError as exc:
            raise RecordingError(
                "storage-unavailable", f"Recording directory must be a real writable directory: {root}"
            ) from exc
        if not stat.S_ISDIR(os.fstat(self._directory).st_mode) or not os.access(root, os.W_OK):
            os.close(self._directory)
            raise RecordingError("storage-unavailable", f"Recording directory is not writable: {root}")
        self.recover()

    def allocate(self, title: str) -> RecordingPaths:
        stamp = self._now().astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
        slug = _slug(title)
        recording_id = f"{stamp}-{slug}-{secrets.token_hex(16)}"
        return self.paths(recording_id)

    def paths(self, recording_id: str) -> RecordingPaths:
        _validate_id(recording_id)
        return RecordingPaths(
            recording_id,
            self.root / f".{recording_id}.wav.part",
            self.root / f"{recording_id}.wav",
            self.root / f"{recording_id}.json",
        )

    def free_bytes(self) -> int:
        stats = os.fstatvfs(self._directory)
        return stats.f_bavail * stats.f_frsize

    def create_part(self, paths: RecordingPaths) -> int:
        return self._open(
            paths.part.name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL,
            mode=0o600,
        )

    def publish_part(self, paths: RecordingPaths) -> None:
        os.replace(paths.part.name, paths.wav.name, src_dir_fd=self._directory, dst_dir_fd=self._directory)
        self._sync()

    def discard_part(self, paths: RecordingPaths) -> None:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(paths.part.name, dir_fd=self._directory)

    def save_manifest(self, manifest: RecordingManifest) -> None:
        paths = self.paths(manifest.id)
        temporary_name = f".{manifest.id}.{secrets.token_hex(16)}.json.part"
        descriptor = self._open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            mode=0o600,
        )
        try:
            output = os.fdopen(descriptor, "w", encoding="utf-8")
            descriptor = -1
            with output:
                json.dump(asdict(manifest), output, ensure_ascii=False, sort_keys=True)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(
                temporary_name,
                paths.manifest.name,
                src_dir_fd=self._directory,
                dst_dir_fd=self._directory,
            )
            self._sync()
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary_name, dir_fd=self._directory)

    def list_saved(self) -> list[RecordingSnapshot]:
        recordings: list[RecordingSnapshot] = []
        for manifest_name in sorted(self._entry_names(suffix=".json"), reverse=True):
            if len(recordings) >= MAX_LISTED_RECORDINGS:
                break
            try:
                raw = self._read_small_regular(manifest_name, MAX_MANIFEST_BYTES)
                manifest = RecordingManifest.from_dict(json.loads(raw), self._format)
                wav_stat = self._regular_stat(f"{manifest.id}.wav")
                if wav_stat.st_size != WAV_HEADER_BYTES + manifest.bytes:
                    continue
                recordings.append(manifest.snapshot())
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError, RecordingError):
                continue
        return recordings

    def open_file(self, recording_id: str) -> OpenedRecording:
        paths = self.paths(recording_id)
        try:
            descriptor = self._open(paths.wav.name, os.O_RDONLY)
            file_stat = os.fstat(descriptor)
        except OSError as exc:
            raise RecordingError("not-found", "Recording not found. Refresh the recording list.") from exc
        return OpenedRecording(paths.wav.name, file_stat.st_size, os.fdopen(descriptor, "rb"))

    def ensure_file(self, recording_id: str) -> None:
        opened = self.open_file(recording_id)
        opened.source.close()

    def has_file(self, recording_id: str) -> bool:
        try:
            self._regular_stat(self.paths(recording_id).wav.name)
        except (OSError, RecordingError):
            return False
        return True

    def delete(self, recording_id: str) -> None:
        paths = self.paths(recording_id)
        try:
            self._regular_stat(paths.wav.name)
            os.unlink(paths.wav.name, dir_fd=self._directory)
        except OSError as exc:
            raise RecordingError("not-found", "Recording not found. Refresh the recording list.") from exc
        with contextlib.suppress(FileNotFoundError):
            os.unlink(paths.manifest.name, dir_fd=self._directory)
        self._sync()

    def recover(self) -> None:
        for part_name in self._entry_names(prefix=".", suffix=".wav.part"):
            recording_id = part_name[1:-9]
            try:
                paths = self.paths(recording_id)
                descriptor = self._open(part_name, os.O_RDWR)
                with os.fdopen(descriptor, "r+b") as output:
                    size = os.fstat(output.fileno()).st_size
                    data_bytes = max(0, size - WAV_HEADER_BYTES)
                    frame_bytes = self._format.channels * self._format.bits // 8
                    data_bytes -= data_bytes % frame_bytes
                    if data_bytes == 0:
                        output.close()
                        os.unlink(part_name, dir_fd=self._directory)
                        continue
                    output.truncate(WAV_HEADER_BYTES + data_bytes)
                    output.seek(0)
                    output.write(wav_header(data_bytes, self._format))
                    output.flush()
                    os.fsync(output.fileno())
                self.publish_part(paths)
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
        for wav_name in self._entry_names(suffix=".wav"):
            recording_id = wav_name[:-4]
            try:
                paths = self.paths(recording_id)
                if self._is_regular(paths.manifest.name):
                    continue
                descriptor = self._open(wav_name, os.O_RDONLY)
                with os.fdopen(descriptor, "rb") as source, wave.open(source, "rb") as recording:
                    if (
                        recording.getframerate(),
                        recording.getnchannels(),
                        recording.getsampwidth() * 8,
                    ) != (self._format.rate, self._format.channels, self._format.bits):
                        continue
                    frames = recording.getnframes()
                    modified_at = os.fstat(source.fileno()).st_mtime
                if frames <= 0 or frames > self._format.rate * DEFAULT_MAX_DURATION_SECONDS:
                    continue
                finished = isoformat(datetime.fromtimestamp(modified_at, UTC))
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
                        wav_name,
                    )
                )
            except (OSError, RecordingError, ValueError, wave.Error):
                continue

    def _open(self, name: str, flags: int, mode: int = 0o600) -> int:
        descriptor = os.open(
            name,
            flags | _os_flag("O_NOFOLLOW") | _os_flag("O_CLOEXEC"),
            mode,
            dir_fd=self._directory,
        )
        artifact = os.fstat(descriptor)
        if not stat.S_ISREG(artifact.st_mode) or artifact.st_nlink != 1:
            os.close(descriptor)
            raise OSError("recording artifact is not a private regular file")
        return descriptor

    def _regular_stat(self, name: str) -> os.stat_result:
        result = os.stat(name, dir_fd=self._directory, follow_symlinks=False)
        if not stat.S_ISREG(result.st_mode) or result.st_nlink != 1:
            raise OSError("recording artifact is not a private regular file")
        return result

    def _is_regular(self, name: str) -> bool:
        try:
            self._regular_stat(name)
        except OSError:
            return False
        return True

    def _read_small_regular(self, name: str, maximum: int) -> str:
        descriptor = self._open(name, os.O_RDONLY)
        with os.fdopen(descriptor, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            if size > maximum:
                raise ValueError("recording manifest is too large")
            return source.read(maximum + 1).decode("utf-8")

    def _entry_names(self, *, prefix: str = "", suffix: str) -> list[str]:
        names: list[str] = []
        with os.scandir(self._directory) as entries:
            for index, entry in enumerate(entries):
                if index >= MAX_STORE_SCAN_ENTRIES:
                    break
                if (
                    entry.name.startswith(prefix)
                    and entry.name.endswith(suffix)
                    and entry.is_file(follow_symlinks=False)
                ):
                    names.append(entry.name)
        return names

    def _sync(self) -> None:
        os.fsync(self._directory)


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
            "saved": self._store.list_saved(),
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
            try:
                session = RecordingSession(
                    paths,
                    title,
                    source.key,
                    self._store,
                    self._limits,
                    self._session_finished,
                )
            except OSError as exc:
                raise RecordingError(
                    "storage-unavailable", "Recording storage is unavailable. Check its permissions and retry."
                ) from exc
            self._sources.retain_recording(source)
            try:
                tap_id = source.hub.register_packet_tap(session.offer)
            except Exception:
                session.discard_unstarted()
                self._sources.release_recording(source)
                raise
            self._active[session.id] = ActiveRecording(source, tap_id, session)
            try:
                session.start()
            except Exception:
                self._active.pop(session.id)
                source.hub.unregister_packet_tap(tap_id)
                self._sources.release_recording(source)
                session.discard_unstarted()
                raise
            return session.snapshot()

    def stop(self, recording_id: str) -> RecordingSnapshot:
        binding = self._detach(recording_id)
        if binding is None:
            raise RecordingError("not-active", "This recording is not active. Refresh the recording list.")
        return binding.session.stop()

    def open_file(self, recording_id: str) -> OpenedRecording:
        return self._store.open_file(recording_id)

    def ensure_file(self, recording_id: str) -> None:
        self._store.ensure_file(recording_id)

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
    if len(recording_id) > MAX_RECORDING_ID_CHARS or not ID_PATTERN.fullmatch(recording_id):
        raise RecordingError("not-found", "Recording not found. Refresh the recording list.")


def _title_from_id(recording_id: str) -> str:
    parts = recording_id.split("-")
    return " ".join(parts[1:-1]).title() or "Recovered recording"


def _manifest_string(data: dict[object, object], name: str, maximum: int) -> str:
    value = data[name]
    if not isinstance(value, str) or len(value) > maximum:
        raise ValueError(f"manifest {name} must be a bounded string")
    return value


def _manifest_int(
    data: dict[object, object],
    name: str,
    minimum: int = 0,
    maximum: int = 0x7FFFFFFF,
) -> int:
    value = data[name]
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"manifest {name} must be a bounded integer")
    return value


def _manifest_timestamp(data: dict[object, object], name: str, *, required: bool) -> str | None:
    value = data[name]
    if value is None and not required:
        return None
    if not isinstance(value, str) or not value or len(value) > MAX_MANIFEST_TIMESTAMP_CHARS:
        raise ValueError(f"manifest {name} must be an ISO timestamp")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def _os_flag(name: str) -> int:
    return int(getattr(os, name, 0))
