"""Source entity base shared by every StreamLine platform."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import StreamLineCoordinator

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

    from homeassistant.helpers.entity import Entity
    from homeassistant.helpers.entity_platform import AddEntitiesCallback

    from .coordinator import StreamLineConfigEntry
    from .models import SourceSnapshot


class StreamLineSourceEntity(CoordinatorEntity[StreamLineCoordinator]):
    """Entity backed by one bridge source snapshot."""

    _attr_has_entity_name = True

    def __init__(self, entry: StreamLineConfigEntry, source: str, key: str) -> None:
        super().__init__(entry.runtime_data)
        self._source = source
        self._attr_unique_id = f"{entry.entry_id}:{source}:{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}:{source}")},
            manufacturer="ESP32 StreamLine",
            model="Bridge source",
            name=f"StreamLine source {source}",
        )

    @property
    def source_snapshot(self) -> SourceSnapshot | None:
        """Return this source's snapshot from the last poll."""
        return self.coordinator.data.status.sources.get(self._source)

    @property
    def available(self) -> bool:
        """Report unavailable while the bridge does not list this source."""
        return super().available and self.source_snapshot is not None


def async_add_source_entities(
    entry: StreamLineConfigEntry,
    async_add_entities: AddEntitiesCallback,
    factory: Callable[[str], Iterable[Entity]],
) -> None:
    """Add entities for every current bridge source and each one that appears later."""
    coordinator = entry.runtime_data
    known: set[str] = set()

    @callback
    def _async_add_new_sources() -> None:
        new = set(coordinator.data.status.sources) - known
        if not new:
            return
        known.update(new)
        async_add_entities([entity for source in sorted(new) for entity in factory(source)])

    entry.async_on_unload(coordinator.async_add_listener(_async_add_new_sources))
    _async_add_new_sources()
