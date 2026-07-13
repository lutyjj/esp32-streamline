"""Measurement and diagnostic sensors for StreamLine sources."""

from dataclasses import dataclass
from typing import TYPE_CHECKING

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.const import PERCENTAGE, EntityCategory

from .entity import StreamLineSourceEntity, async_add_dynamic_source_entities

if TYPE_CHECKING:
    from collections.abc import Callable

    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import StreamLineConfigEntry
    from .generated import SourceSnapshot


@dataclass(frozen=True, slots=True)
class StreamLineSensorDescription:
    """Describe one coordinator-backed source measurement."""

    key: str
    translation_key: str
    value: Callable[[SourceSnapshot], int | float]
    native_unit: str | None = None
    state_class: SensorStateClass | None = None
    entity_category: EntityCategory | None = None
    enabled_default: bool = True


SENSORS = (
    StreamLineSensorDescription(
        key="peak_level",
        translation_key="peak_level",
        value=lambda source: round(
            max(source.levels.peak_left, source.levels.peak_right) * 100 / 32768,
            1,
        ),
        native_unit=PERCENTAGE,
        state_class=SensorStateClass.MEASUREMENT,
    ),
    StreamLineSensorDescription(
        key="listeners",
        translation_key="listeners",
        value=lambda source: source.clients,
        entity_category=EntityCategory.DIAGNOSTIC,
    ),
    StreamLineSensorDescription(
        key="lost_packets",
        translation_key="lost_packets",
        value=lambda source: source.lost,
        state_class=SensorStateClass.TOTAL_INCREASING,
        entity_category=EntityCategory.DIAGNOSTIC,
        enabled_default=False,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up source sensors and follow new sources."""
    async_add_dynamic_source_entities(
        entry,
        async_add_entities,
        lambda source: (
            StreamLineSourceSensor(entry, source, description) for description in SENSORS
        ),
    )


class StreamLineSourceSensor(StreamLineSourceEntity, SensorEntity):
    """Expose one source value from coordinator memory."""

    def __init__(
        self,
        entry: StreamLineConfigEntry,
        source: str,
        description: StreamLineSensorDescription,
    ) -> None:
        super().__init__(entry, source, description.key)
        self._description = description
        self._attr_translation_key = description.translation_key
        self._attr_native_unit_of_measurement = description.native_unit
        self._attr_state_class = description.state_class
        self._attr_entity_category = description.entity_category
        self._attr_entity_registry_enabled_default = description.enabled_default

    @property
    def native_value(self) -> int | float | None:
        """Return the current measurement without I/O."""
        if (snapshot := self.source_snapshot) is None:
            return None
        return self._description.value(snapshot)
