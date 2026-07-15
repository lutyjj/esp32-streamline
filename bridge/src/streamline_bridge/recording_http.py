"""Recording operations and download-ticket policy."""

from __future__ import annotations

import secrets
import threading
import time
from typing import TYPE_CHECKING

from streamline_bridge.recording import RecordingError, recording_capabilities

if TYPE_CHECKING:
    from collections.abc import Callable

    from streamline_bridge.recording import OpenedRecording, RecordingService

DOWNLOAD_TICKET_SECONDS = 60
MAX_DOWNLOAD_TICKETS = 128


class RecordingHttpService:
    """Expose recording operations behind the app's one authenticated boundary."""

    def __init__(
        self,
        service: RecordingService | None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._service = service
        self._monotonic = monotonic
        self._ticket_lock = threading.Lock()
        self._tickets: dict[str, tuple[str, float]] = {}

    def capabilities(self) -> dict[str, object]:
        return self._service.capabilities() if self._service is not None else recording_capabilities(False)

    def list(self) -> dict[str, object]:
        return self._enabled().list()

    def start(self, source: str, title: str) -> dict[str, object]:
        return {"recording": self._enabled().start(source, title)}

    def stop(self, recording_id: str) -> dict[str, object]:
        return {"recording": self._enabled().stop(recording_id)}

    def delete(self, recording_id: str) -> dict[str, object]:
        self._enabled().delete(recording_id)
        return {"deleted": recording_id}

    def issue_download(self, recording_id: str) -> dict[str, object]:
        self._enabled().ensure_file(recording_id)
        ticket = secrets.token_urlsafe(24)
        with self._ticket_lock:
            self._discard_expired_tickets_locked()
            while len(self._tickets) >= MAX_DOWNLOAD_TICKETS:
                del self._tickets[next(iter(self._tickets))]
            self._tickets[ticket] = (recording_id, self._monotonic() + DOWNLOAD_TICKET_SECONDS)
        return {
            "url": f"/api/recordings/{recording_id}/file?ticket={ticket}",
            "expires_in_seconds": DOWNLOAD_TICKET_SECONDS,
        }

    def open_download(self, recording_id: str, ticket: str) -> OpenedRecording:
        with self._ticket_lock:
            self._discard_expired_tickets_locked()
            accepted = self._tickets.pop(ticket, None)
        if accepted is None or accepted[0] != recording_id:
            raise RecordingError("unauthorized", "Request a new recording download.")
        return self._enabled().open_file(recording_id)

    def open_authorized(self, recording_id: str) -> OpenedRecording:
        """Open a recording after the HTTP adapter validates bearer auth."""
        return self._enabled().open_file(recording_id)

    def _enabled(self) -> RecordingService:
        if self._service is None:
            raise RecordingError(
                "recording-disabled",
                "Recording is disabled. Configure writable recording storage and restart the bridge.",
            )
        return self._service

    def _discard_expired_tickets_locked(self) -> None:
        now = self._monotonic()
        for ticket, (_, expires_at) in tuple(self._tickets.items()):
            if expires_at <= now:
                del self._tickets[ticket]
