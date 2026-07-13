"""Home Assistant integration for ESP32 StreamLine bridges."""

from typing import TYPE_CHECKING

from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import StreamLineBridgeClient
from .const import CONF_BRIDGE_URL, CONF_RECORDING_TOKEN, DOMAIN, PLATFORMS
from .coordinator import StreamLineConfigEntry, StreamLineCoordinator
from .http import StreamLineRecordingView
from .services import async_setup_services

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.typing import ConfigType

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register stable actions and the authenticated media proxy."""
    await async_setup_services(hass)
    hass.http.register_view(StreamLineRecordingView(hass))
    return True


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
    """Unload all source platforms for one bridge."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
