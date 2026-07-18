"""Own one pinned recording directory and its untrusted artifact lifecycle."""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import stat
import wave
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, BinaryIO

from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.recording.model import (
    DEFAULT_MAX_DURATION_SECONDS,
    MAX_MANIFEST_BYTES,
    WAV_HEADER_BYTES,
    RecordingError,
    RecordingManifest,
    RecordingSnapshot,
    isoformat,
    slug,
    title_from_id,
    utc_now,
    validate_id,
)
from streamline_bridge.recording.wav import wav_header

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

MAX_STORE_SCAN_ENTRIES = 10_000
MAX_LISTED_RECORDINGS = 1_000


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
        recording_id = f"{stamp}-{slug(title)}-{secrets.token_hex(16)}"
        return self.paths(recording_id)

    def paths(self, recording_id: str) -> RecordingPaths:
        validate_id(recording_id)
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
                        title_from_id(recording_id),
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
                        title_from_id(recording_id),
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
        flags = os.O_RDONLY | _os_flag("O_DIRECTORY") | _os_flag("O_NOFOLLOW") | _os_flag("O_CLOEXEC")
        directory = os.open(".", flags, dir_fd=self._directory)
        try:
            with os.scandir(directory) as entries:
                for index, entry in enumerate(entries):
                    if index >= MAX_STORE_SCAN_ENTRIES:
                        break
                    if (
                        entry.name.startswith(prefix)
                        and entry.name.endswith(suffix)
                        and entry.is_file(follow_symlinks=False)
                    ):
                        names.append(entry.name)
        finally:
            os.close(directory)
        return names

    def _sync(self) -> None:
        os.fsync(self._directory)


def _os_flag(name: str) -> int:
    return int(getattr(os, name, 0))
