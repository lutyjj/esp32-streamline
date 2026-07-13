"""UI configuration for StreamLine bridges."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from yarl import URL

from .api import StreamLineBridgeClient, normalize_bridge_url
from .const import CONF_BRIDGE_URL, CONF_RECORDING_TOKEN, DOMAIN
from .errors import (
    StreamLineApiError,
    StreamLineAuthenticationError,
    StreamLineCannotConnect,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

TOKEN_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))
DEFAULT_BRIDGE_URL = "http://homeassistant.local:8088"


class StreamLineConfigFlow(ConfigFlow, domain=DOMAIN):
    """Configure one StreamLine bridge."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Create an entry for one verified bridge URL."""
        errors: dict[str, str] = {}
        if user_input is not None:
            data, errors = await self._async_validated_data(user_input)
            if not errors:
                self._async_abort_entries_match({CONF_BRIDGE_URL: data[CONF_BRIDGE_URL]})
                return self.async_create_entry(title=_entry_title(data[CONF_BRIDGE_URL]), data=data)
        return self.async_show_form(
            step_id="user", data_schema=_schema(user_input or {}), errors=errors
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Replace the bridge URL or recording token after verification."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data, errors = await self._async_validated_data(user_input)
            if not errors:
                return self.async_update_reload_and_abort(entry, data=data)
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_schema(user_input or entry.data),
            errors=errors,
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """Start the repair flow for a rejected recording token."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Verify and save a replacement recording token."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data, errors = await self._async_validated_data({**entry.data, **user_input})
            if not errors:
                return self.async_update_reload_and_abort(entry, data=data)
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_RECORDING_TOKEN): TOKEN_SELECTOR}),
            errors=errors,
        )

    async def _async_validated_data(
        self, user_input: Mapping[str, Any]
    ) -> tuple[dict[str, str], dict[str, str]]:
        """Verify bridge access and return normalized entry data."""
        try:
            bridge_url = normalize_bridge_url(str(user_input.get(CONF_BRIDGE_URL, "")))
        except StreamLineApiError:
            return {}, {CONF_BRIDGE_URL: "invalid_url"}
        token = str(user_input.get(CONF_RECORDING_TOKEN, "")).strip()
        client = StreamLineBridgeClient(
            async_get_clientsession(self.hass), bridge_url, token or None
        )
        try:
            await client.async_get_status()
            if token and (await client.async_get_recording_capabilities()).enabled:
                await client.async_get_recordings()
        except StreamLineAuthenticationError:
            return {}, {CONF_RECORDING_TOKEN: "invalid_auth"}
        except StreamLineCannotConnect:
            return {}, {"base": "cannot_connect"}
        except StreamLineApiError:
            return {}, {"base": "invalid_response"}
        data = {CONF_BRIDGE_URL: bridge_url}
        if token:
            data[CONF_RECORDING_TOKEN] = token
        return data, {}


def _schema(defaults: Mapping[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_BRIDGE_URL, default=defaults.get(CONF_BRIDGE_URL, DEFAULT_BRIDGE_URL)
            ): str,
            vol.Optional(
                CONF_RECORDING_TOKEN, default=defaults.get(CONF_RECORDING_TOKEN, "")
            ): TOKEN_SELECTOR,
        }
    )


def _entry_title(bridge_url: str) -> str:
    return URL(bridge_url).host or bridge_url
