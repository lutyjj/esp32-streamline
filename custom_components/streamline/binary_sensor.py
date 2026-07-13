"""Streaming-state sensor for StreamLine bridge sources."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)

from .entity import StreamLineSourceEntity, async_add_source_entities

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import StreamLineConfigEntry


async def async_setup_entry(
    hass: HomeAssistant,
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add one streaming sensor per bridge source."""
    async_add_source_entities(
        entry,
        async_add_entities,
        lambda source: (StreamLineStreamingSensor(entry, source),),
    )


class StreamLineStreamingSensor(StreamLineSourceEntity, BinarySensorEntity):
    """Report whether a source has an active PCM producer connection."""

    _attr_device_class = BinarySensorDeviceClass.RUNNING
    _attr_translation_key = "audio_streaming"

    def __init__(self, entry: StreamLineConfigEntry, source: str) -> None:
        super().__init__(entry, source, "audio_streaming")

    @property
    def is_on(self) -> bool | None:
        """Return whether the source connection delivers audio."""
        if (snapshot := self.source_snapshot) is None:
            return None
        return snapshot.lifecycle.state == "connected"
