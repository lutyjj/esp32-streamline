"""Authenticated Home Assistant proxy for bridge recording files."""

from __future__ import annotations

from typing import TYPE_CHECKING

from aiohttp import web
from homeassistant.helpers.http import HomeAssistantView

from .const import DOMAIN
from .errors import StreamLineApiError

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .coordinator import StreamLineConfigEntry


class StreamLineRecordingView(HomeAssistantView):
    """Stream one ticketed bridge file through Home Assistant."""

    url = "/api/streamline/recordings/{entry_id}/{recording_id}"
    name = "api:streamline:recording"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def get(
        self, request: web.Request, entry_id: str, recording_id: str
    ) -> web.StreamResponse:
        """Mint a one-use bridge ticket and proxy its WAV body."""
        entry = self._hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN or entry.runtime_data is None:
            raise web.HTTPNotFound
        typed_entry: StreamLineConfigEntry = entry
        try:
            upstream = await typed_entry.runtime_data.client.async_open_recording(recording_id)
        except StreamLineApiError as exc:
            raise web.HTTPBadGateway(text="The StreamLine recording is unavailable.") from exc

        headers = {"Cache-Control": "private, no-store"}
        if length := upstream.headers.get("Content-Length"):
            headers["Content-Length"] = length
        response = web.StreamResponse(headers=headers)
        response.content_type = "audio/wav"
        await response.prepare(request)
        try:
            async for chunk in upstream.content.iter_chunked(64 * 1024):
                await response.write(chunk)
        finally:
            upstream.release()
        await response.write_eof()
        return response
