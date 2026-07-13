"""Home Assistant media library for StreamLine bridge recordings."""

from __future__ import annotations

from typing import TYPE_CHECKING, override

from homeassistant.components.media_player.const import MediaClass, MediaType
from homeassistant.components.media_player.errors import BrowseError
from homeassistant.components.media_source import (
    BrowseMediaSource,
    MediaSource,
    MediaSourceItem,
    PlayMedia,
    Unresolvable,
)

from .const import DOMAIN
from .errors import StreamLineApiError

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .coordinator import StreamLineConfigEntry

SEPARATOR = "|"


async def async_get_media_source(hass: HomeAssistant) -> MediaSource:
    """Register StreamLine as one Home Assistant media source."""
    return StreamLineMediaSource(hass)


class StreamLineMediaSource(MediaSource):
    """Browse and resolve finalized WAV files from configured bridges."""

    name = "StreamLine"

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(DOMAIN)
        self._hass = hass

    @override
    async def async_browse_media(self, item: MediaSourceItem) -> BrowseMediaSource:
        """Return bridge folders or the saved files on one bridge."""
        entries = [
            entry
            for entry in self._hass.config_entries.async_loaded_entries(DOMAIN)
            if self._recordings_available(entry)
        ]
        if not item.identifier:
            return BrowseMediaSource(
                domain=DOMAIN,
                identifier=None,
                media_class=MediaClass.DIRECTORY,
                media_content_type=MediaType.MUSIC,
                title="StreamLine",
                can_play=False,
                can_expand=True,
                children_media_class=MediaClass.DIRECTORY,
                children=[
                    BrowseMediaSource(
                        domain=DOMAIN,
                        identifier=entry.entry_id,
                        media_class=MediaClass.DIRECTORY,
                        media_content_type=MediaType.MUSIC,
                        title=entry.title,
                        can_play=False,
                        can_expand=True,
                        children_media_class=MediaClass.MUSIC,
                    )
                    for entry in entries
                ],
            )

        entry = self._entry(item.identifier.split(SEPARATOR, 1)[0])
        if SEPARATOR in item.identifier:
            raise BrowseError("A StreamLine recording is playable but not browsable.")
        try:
            catalog = await entry.runtime_data.client.async_get_recordings()
        except StreamLineApiError as exc:
            raise BrowseError("Could not read StreamLine recordings.") from exc
        return BrowseMediaSource(
            domain=DOMAIN,
            identifier=entry.entry_id,
            media_class=MediaClass.DIRECTORY,
            media_content_type=MediaType.MUSIC,
            title=entry.title,
            can_play=False,
            can_expand=True,
            children_media_class=MediaClass.MUSIC,
            children=[
                BrowseMediaSource(
                    domain=DOMAIN,
                    identifier=f"{entry.entry_id}{SEPARATOR}{recording.id}",
                    media_class=MediaClass.MUSIC,
                    media_content_type="audio/wav",
                    title=recording.title,
                    can_play=True,
                    can_expand=False,
                )
                for recording in catalog.saved
                if recording.file_name is not None
            ],
        )

    @override
    async def async_resolve_media(self, item: MediaSourceItem) -> PlayMedia:
        """Resolve one recording to the authenticated Home Assistant proxy."""
        parts = item.identifier.split(SEPARATOR)
        if len(parts) != 2 or not all(parts):
            raise Unresolvable("Select a StreamLine recording.")
        entry = self._entry(parts[0], resolvable=True)
        return PlayMedia(f"/api/streamline/recordings/{entry.entry_id}/{parts[1]}", "audio/wav")

    def _entry(self, entry_id: str, *, resolvable: bool = False) -> StreamLineConfigEntry:
        entry = self._hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN or entry.runtime_data is None:
            if resolvable:
                raise Unresolvable("The StreamLine bridge is not loaded.")
            raise BrowseError("The StreamLine bridge is not loaded.")
        typed_entry: StreamLineConfigEntry = entry
        if not self._recordings_available(typed_entry):
            if resolvable:
                raise Unresolvable("StreamLine recordings are not available.")
            raise BrowseError("StreamLine recordings are not available.")
        return typed_entry

    @staticmethod
    def _recordings_available(entry: StreamLineConfigEntry) -> bool:
        """Return whether a loaded bridge can serve recording media."""
        data = entry.runtime_data.data
        return (
            entry.runtime_data.client.has_recording_token
            and data is not None
            and data.capabilities.enabled
        )
