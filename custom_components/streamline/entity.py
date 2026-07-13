"""Source entity boundary shared by StreamLine platforms."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import StreamLineConfigEntry, StreamLineCoordinator

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from homeassistant.helpers.entity import Entity
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .generated import SourceSnapshot


class StreamLineSourceEntity(CoordinatorEntity[StreamLineCoordinator]):
    """Base entity backed by one bridge source snapshot."""

    _attr_has_entity_name = True

    def __init__(self, entry: StreamLineConfigEntry, source: str, key: str) -> None:
        super().__init__(entry.runtime_data)
        self._entry = entry
        self._source = source
        self._attr_unique_id = f"{entry.entry_id}:{source}:{key}"

    @property
    def source_snapshot(self) -> SourceSnapshot | None:
        """Return the current in-memory source snapshot."""
        return self.coordinator.data.status.sources.get(self._source)

    @property
    def available(self) -> bool:
        """Report source availability without doing I/O."""
        return super().available and self.source_snapshot is not None

    @property
    def device_info(self) -> DeviceInfo:
        """Group every source entity under one Home Assistant device."""
        return DeviceInfo(
            identifiers={(DOMAIN, f"{self._entry.entry_id}:{self._source}")},
            manufacturer="ESP32 StreamLine",
            model="Bridge source",
            name=f"StreamLine source {self._source}",
        )


def async_add_dynamic_source_entities(
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
    factory: Callable[[str], Iterable[Entity]],
) -> None:
    """Add entities for current and future bridge sources once."""
    known_sources: set[str] = set()

    @callback
    def add_new_sources() -> None:
        new_sources = set(entry.runtime_data.data.status.sources) - known_sources
        if not new_sources:
            return
        known_sources.update(new_sources)
        async_add_entities([entity for source in sorted(new_sources) for entity in factory(source)])

    entry.async_on_unload(entry.runtime_data.async_add_listener(add_new_sources))
    add_new_sources()
