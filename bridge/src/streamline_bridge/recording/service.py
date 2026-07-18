"""Coordinate source retention, packet taps, sessions, and storage."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING

from streamline_bridge.recording.model import (
    DEFAULT_RECORDING_LIMITS,
    RecordingError,
    RecordingLimits,
    RecordingSnapshot,
    recording_capabilities,
    validate_title,
)
from streamline_bridge.recording.session import RecordingSession
from streamline_bridge.sources import SourceSelectionError

if TYPE_CHECKING:
    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.recording.store import OpenedRecording, RecordingStore
    from streamline_bridge.sources import SourceLease, SourceRegistry


@dataclass
class ActiveRecording:
    lease: SourceLease[AudioPipeline]
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
        title = validate_title(title, self._limits.max_title_chars)
        if self._store.free_bytes() < self._limits.min_free_bytes:
            raise RecordingError("storage-full", "Recording needs at least 256 MiB free. Delete files and retry.")
        try:
            lease = self._sources.lease_recording(source_key)
        except SourceSelectionError as exc:
            raise RecordingError("invalid-source", exc.message) from exc
        source = lease.source
        with self._lock:
            if any(binding.lease.source is source for binding in self._active.values()):
                lease.close()
                raise RecordingError(
                    "source-busy", "This source is already recording. Stop it before starting another."
                )
            try:
                paths = self._store.allocate(title)
                session = RecordingSession(
                    paths,
                    title,
                    source.key,
                    self._store,
                    self._limits,
                    self._session_finished,
                )
            except OSError as exc:
                lease.close()
                raise RecordingError(
                    "storage-unavailable", "Recording storage is unavailable. Check its permissions and retry."
                ) from exc
            except BaseException:
                lease.close()
                raise
            try:
                tap_id = source.hub.register_packet_tap(session.offer)
            except Exception:
                session.discard_unstarted()
                lease.close()
                raise
            self._active[session.id] = ActiveRecording(lease, tap_id, session)
            try:
                session.start()
            except Exception:
                self._active.pop(session.id)
                source.hub.unregister_packet_tap(tap_id)
                lease.close()
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
            binding.lease.hub.unregister_packet_tap(binding.tap_id)
            binding.lease.close()
        return binding
