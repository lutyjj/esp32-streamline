"""One shared bridge poll behind every StreamLine entity."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from homeassistant.config_entries import ConfigEntry
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import DOMAIN, UPDATE_INTERVAL
from .errors import StreamLineApiError, StreamLineAuthenticationError

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .api import StreamLineBridgeClient
    from .models import BridgeStatus, RecordingList, RecordingSnapshot

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class StreamLineData:
    """One coherent view of bridge state."""

    status: BridgeStatus
    # Recording sessions and files, or None while recording is unavailable
    # because the entry has no token or the bridge has no recording storage.
    recordings: RecordingList | None


class StreamLineCoordinator(DataUpdateCoordinator[StreamLineData]):
    """Poll the bridge once for every entity."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: StreamLineBridgeClient,
    ) -> None:
        super().__init__(
            hass,
            logger=LOGGER,
            config_entry=entry,
            name=DOMAIN,
            update_interval=UPDATE_INTERVAL,
        )
        self.client = client

    async def _async_update_data(self) -> StreamLineData:
        try:
            status = await self.client.async_get_status()
            recordings = await self._async_recordings()
        except StreamLineAuthenticationError as exc:
            raise ConfigEntryAuthFailed(str(exc)) from exc
        except StreamLineApiError as exc:
            raise UpdateFailed(str(exc)) from exc
        return StreamLineData(status=status, recordings=recordings)

    async def _async_recordings(self) -> RecordingList | None:
        if not self.client.has_recording_token:
            return None
        capabilities = await self.client.async_get_recording_capabilities()
        if not capabilities.enabled:
            return None
        return await self.client.async_get_recordings()

    async def async_start_recording(self, source: str, title: str) -> RecordingSnapshot:
        recording = await self.client.async_start_recording(source, title)
        await self.async_request_refresh()
        return recording

    async def async_stop_recording(self, recording_id: str) -> RecordingSnapshot:
        recording = await self.client.async_stop_recording(recording_id)
        await self.async_request_refresh()
        return recording


type StreamLineConfigEntry = ConfigEntry[StreamLineCoordinator]
