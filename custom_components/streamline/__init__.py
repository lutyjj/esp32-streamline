"""Home Assistant integration for the ESP32 StreamLine bridge."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import StreamLineBridgeClient
from .const import CONF_BRIDGE_URL, CONF_RECORDING_TOKEN, PLATFORMS
from .coordinator import StreamLineCoordinator

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .coordinator import StreamLineConfigEntry


async def async_setup_entry(hass: HomeAssistant, entry: StreamLineConfigEntry) -> bool:
    """Connect one bridge and start its shared coordinator."""
    client = StreamLineBridgeClient(
        async_get_clientsession(hass),
        entry.data[CONF_BRIDGE_URL],
        entry.data.get(CONF_RECORDING_TOKEN),
    )
    coordinator = StreamLineCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: StreamLineConfigEntry) -> bool:
    """Unload every platform of one bridge entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
