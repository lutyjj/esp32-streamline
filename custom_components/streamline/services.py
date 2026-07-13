"""Home Assistant recording actions for StreamLine."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntryState
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import (
    ATTR_CONFIG_ENTRY_ID,
    ATTR_RECORDING_ID,
    ATTR_SOURCE,
    ATTR_TITLE,
    DOMAIN,
    SERVICE_DELETE_RECORDING,
    SERVICE_START_RECORDING,
    SERVICE_STOP_RECORDING,
)
from .errors import StreamLineApiError

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant, ServiceCall

    from .coordinator import StreamLineConfigEntry, StreamLineCoordinator

ENTRY_SCHEMA = {vol.Required(ATTR_CONFIG_ENTRY_ID): cv.string}
START_SCHEMA = vol.Schema(
    {
        **ENTRY_SCHEMA,
        vol.Required(ATTR_SOURCE): cv.string,
        vol.Required(ATTR_TITLE): vol.All(cv.string, vol.Length(min=1, max=80)),
    }
)
RECORDING_SCHEMA = vol.Schema({**ENTRY_SCHEMA, vol.Required(ATTR_RECORDING_ID): cv.string})


async def async_setup_services(hass: HomeAssistant) -> None:
    """Register actions even when no bridge entry is loaded."""

    async def start_recording(call: ServiceCall) -> None:
        coordinator = _coordinator(hass, call)
        await _run(coordinator.async_start_recording(call.data[ATTR_SOURCE], call.data[ATTR_TITLE]))

    async def stop_recording(call: ServiceCall) -> None:
        await _run(_coordinator(hass, call).async_stop_recording(call.data[ATTR_RECORDING_ID]))

    async def delete_recording(call: ServiceCall) -> None:
        await _run(_coordinator(hass, call).async_delete_recording(call.data[ATTR_RECORDING_ID]))

    hass.services.async_register(
        DOMAIN, SERVICE_START_RECORDING, start_recording, schema=START_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_STOP_RECORDING, stop_recording, schema=RECORDING_SCHEMA
    )
    hass.services.async_register(
        DOMAIN, SERVICE_DELETE_RECORDING, delete_recording, schema=RECORDING_SCHEMA
    )


def _coordinator(hass: HomeAssistant, call: ServiceCall) -> StreamLineCoordinator:
    entry = hass.config_entries.async_get_entry(call.data[ATTR_CONFIG_ENTRY_ID])
    if entry is None or entry.domain != DOMAIN or entry.state is not ConfigEntryState.LOADED:
        raise ServiceValidationError("Select a loaded StreamLine bridge.")
    typed_entry: StreamLineConfigEntry = entry
    return typed_entry.runtime_data


async def _run(operation: Any) -> None:
    try:
        await operation
    except StreamLineApiError as exc:
        raise ServiceValidationError(str(exc)) from exc
