"""Measurement and diagnostic sensors for StreamLine bridge sources."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.const import PERCENTAGE, EntityCategory

from .entity import StreamLineSourceEntity, async_add_source_entities

if TYPE_CHECKING:
    from collections.abc import Callable

    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import StreamLineConfigEntry
    from .models import SourceSnapshot

# 16-bit PCM peaks arrive as 0..32768; entities expose them as a percentage.
PEAK_FULL_SCALE = 32768


@dataclass(frozen=True, kw_only=True)
class StreamLineSensorDescription(SensorEntityDescription):
    """Describe one measurement read from a source snapshot."""

    value_fn: Callable[[SourceSnapshot], int | float]


SENSORS: tuple[StreamLineSensorDescription, ...] = (
    StreamLineSensorDescription(
        key="peak_level",
        translation_key="peak_level",
        native_unit_of_measurement=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
        value_fn=lambda source: round(
            max(source.levels.peak_left, source.levels.peak_right) * 100 / PEAK_FULL_SCALE, 1
        ),
    ),
    StreamLineSensorDescription(
        key="listeners",
        translation_key="listeners",
        state_class=SensorStateClass.MEASUREMENT,
        entity_category=EntityCategory.DIAGNOSTIC,
        value_fn=lambda source: source.clients,
    ),
    StreamLineSensorDescription(
        key="lost_packets",
        translation_key="lost_packets",
        state_class=SensorStateClass.TOTAL_INCREASING,
        entity_category=EntityCategory.DIAGNOSTIC,
        entity_registry_enabled_default=False,
        value_fn=lambda source: source.lost,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Add the described sensors for every bridge source."""
    async_add_source_entities(
        entry,
        async_add_entities,
        lambda source: (
            StreamLineSourceSensor(entry, source, description) for description in SENSORS
        ),
    )


class StreamLineSourceSensor(StreamLineSourceEntity, SensorEntity):
    """Expose one source measurement from the shared poll."""

    entity_description: StreamLineSensorDescription

    def __init__(
        self,
        entry: StreamLineConfigEntry,
        source: str,
        description: StreamLineSensorDescription,
    ) -> None:
        super().__init__(entry, source, description.key)
        self.entity_description = description

    @property
    def native_value(self) -> int | float | None:
        """Return the current measurement without I/O."""
        if (snapshot := self.source_snapshot) is None:
            return None
        return self.entity_description.value_fn(snapshot)
