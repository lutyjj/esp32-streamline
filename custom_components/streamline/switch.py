"""Recording control for StreamLine bridge sources."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.exceptions import HomeAssistantError
from homeassistant.util import dt as dt_util

from .entity import StreamLineSourceEntity, async_add_source_entities
from .errors import StreamLineApiError

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import StreamLineConfigEntry
    from .models import RecordingSnapshot


async def async_setup_entry(
    hass: HomeAssistant,
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add one recording switch per bridge source."""
    async_add_source_entities(
        entry,
        async_add_entities,
        lambda source: (StreamLineRecordingSwitch(entry, source),),
    )


class StreamLineRecordingSwitch(StreamLineSourceEntity, SwitchEntity):
    """Start or stop the recording session of one source."""

    _attr_translation_key = "recording"

    def __init__(self, entry: StreamLineConfigEntry, source: str) -> None:
        super().__init__(entry, source, "recording")

    @property
    def available(self) -> bool:
        """Require a current source and an entry with recording access."""
        return super().available and self.coordinator.data.recordings is not None

    @property
    def is_on(self) -> bool | None:
        """Return whether this source owns an active recording session."""
        if self.coordinator.data.recordings is None:
            return None
        return self._active_recording is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose the active session for dashboards and automations."""
        if (recording := self._active_recording) is None:
            return None
        return {
            "recording_id": recording.id,
            "title": recording.title,
            "state": recording.state,
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Start a recording with a timestamped title."""
        if self._active_recording is not None:
            return
        title = f"Recording {dt_util.now().strftime('%Y-%m-%d %H:%M:%S')}"
        try:
            await self.coordinator.async_start_recording(self._source, title)
        except StreamLineApiError as exc:
            raise HomeAssistantError(str(exc)) from exc

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Stop and finalize the active session of this source."""
        if (recording := self._active_recording) is None:
            return
        try:
            await self.coordinator.async_stop_recording(recording.id)
        except StreamLineApiError as exc:
            raise HomeAssistantError(str(exc)) from exc

    @property
    def _active_recording(self) -> RecordingSnapshot | None:
        """Return this source's session from the bridge's active list."""
        if (recordings := self.coordinator.data.recordings) is None:
            return None
        return next(
            (recording for recording in recordings.active if recording.source == self._source),
            None,
        )
