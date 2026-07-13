"""Home Assistant media browsing and playback resolution tests."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock

import pytest
from homeassistant.components.media_source import MediaSourceItem, Unresolvable

from custom_components.streamline.const import DOMAIN
from custom_components.streamline.coordinator import StreamLineData
from custom_components.streamline.media_source import StreamLineMediaSource

from .model_fixtures import recording_capabilities, recording_list, recording_snapshot
from .test_integration import setup_entry

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from typing import Any

    from homeassistant.core import HomeAssistant
    from pytest_homeassistant_custom_component.typing import (  # type: ignore[import-untyped]
        ClientSessionGenerator,
    )


async def test_saved_recordings_browse_and_resolve_through_home_assistant(
    hass: HomeAssistant,
) -> None:
    """Issue #163 exposes finalized WAV files without leaking bridge tickets."""
    entry = await setup_entry(hass)
    saved = recording_snapshot()
    entry.runtime_data.client.async_get_recordings = AsyncMock(
        return_value=recording_list(saved=(saved,))
    )
    source = StreamLineMediaSource(hass)

    root = await source.async_browse_media(MediaSourceItem(hass, DOMAIN, "", None))
    bridge = await source.async_browse_media(MediaSourceItem(hass, DOMAIN, entry.entry_id, None))
    resolved = await source.async_resolve_media(
        MediaSourceItem(hass, DOMAIN, f"{entry.entry_id}|recording-1", None)
    )

    assert root.children is not None and root.children[0].title == "Bridge"
    assert bridge.children is not None and bridge.children[0].title == "Album side A"
    assert bridge.children[0].media_content_id.startswith("media-source://streamline/")
    assert resolved.url == f"/api/streamline/recordings/{entry.entry_id}/recording-1"
    assert "ticket" not in resolved.url
    assert resolved.mime_type == "audio/wav"


async def test_disabled_recordings_are_not_exposed_as_media(
    hass: HomeAssistant,
) -> None:
    """Media stays absent when the bridge reports recording as disabled."""
    entry = await setup_entry(hass)
    current = entry.runtime_data.data
    assert current is not None
    entry.runtime_data.data = StreamLineData(
        current.status, recording_capabilities(enabled=False), None
    )
    source = StreamLineMediaSource(hass)

    root = await source.async_browse_media(MediaSourceItem(hass, DOMAIN, "", None))

    assert root.children == []
    with pytest.raises(Unresolvable, match="not available"):
        await source.async_resolve_media(
            MediaSourceItem(hass, DOMAIN, f"{entry.entry_id}|recording-1", None)
        )


async def test_authenticated_proxy_streams_a_fresh_ticketed_wav(
    hass: HomeAssistant, hass_client: ClientSessionGenerator
) -> None:
    """The player receives WAV bytes without receiving bridge credentials or tickets."""
    entry = await setup_entry(hass)

    async def chunks(_size: int) -> AsyncIterator[bytes]:
        yield b"RIFF"
        yield b"WAVE"

    upstream: Any = MagicMock()
    upstream.headers = {"Content-Length": "8"}
    upstream.content.iter_chunked = chunks
    entry.runtime_data.client.async_open_recording = AsyncMock(return_value=upstream)
    client = await hass_client()

    response = await client.get(f"/api/streamline/recordings/{entry.entry_id}/recording-1")

    assert response.status == 200
    assert response.headers["Content-Type"] == "audio/wav"
    assert response.headers["Cache-Control"] == "private, no-store"
    assert await response.read() == b"RIFFWAVE"
    entry.runtime_data.client.async_open_recording.assert_awaited_once_with("recording-1")
    upstream.release.assert_called_once_with()
