"""Recording switches for StreamLine bridge sources."""

from typing import TYPE_CHECKING, Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.util import dt as dt_util

from .const import ACTIVE_RECORDING_STATES
from .entity import StreamLineSourceEntity, async_add_dynamic_source_entities

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import StreamLineConfigEntry
    from .generated import RecordingSnapshot


async def async_setup_entry(
    hass: HomeAssistant,
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up one recording control per source and follow new sources."""
    async_add_dynamic_source_entities(
        entry,
        async_add_entities,
        lambda source: (StreamLineRecordingSwitch(entry, source),),
    )


class StreamLineRecordingSwitch(StreamLineSourceEntity, SwitchEntity):
    """Start or stop the active recording for one source."""

    _attr_translation_key = "recording"

    def __init__(self, entry: StreamLineConfigEntry, source: str) -> None:
        super().__init__(entry, source, "recording")

    @property
    def available(self) -> bool:
        """Require recording storage, a token, and a current source."""
        return (
            super().available
            and self.coordinator.data.capabilities.enabled
            and self.coordinator.data.recordings is not None
        )

    @property
    def is_on(self) -> bool | None:
        """Return whether this source owns an active recording session."""
        if not self.available:
            return None
        return self._active_recording is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose safe session facts for dashboards and automations."""
        if (recording := self._active_recording) is None:
            return None
        return {
            "recording_id": recording.id,
            "title": recording.title,
            "state": recording.state,
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Start with a deterministic default title."""
        if self._active_recording is not None:
            return
        timestamp = dt_util.now().strftime("%Y-%m-%d %H:%M:%S")
        await self.coordinator.async_start_recording(self._source, f"Recording {timestamp}")

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Stop the active session for this source."""
        if (recording := self._active_recording) is None:
            return
        await self.coordinator.async_stop_recording(recording.id)

    @property
    def _active_recording(self) -> RecordingSnapshot | None:
        recordings = self.coordinator.data.recordings
        if recordings is None:
            return None
        return next(
            (
                recording
                for recording in recordings.active
                if recording.source == self._source and recording.state in ACTIVE_RECORDING_STATES
            ),
            None,
        )
