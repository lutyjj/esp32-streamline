"""UI configuration for StreamLine bridges."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, override
from urllib.parse import urlsplit

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .api import StreamLineBridgeClient, normalize_bridge_url
from .const import CONF_BRIDGE_URL, CONF_RECORDING_TOKEN, DOMAIN
from .errors import (
    StreamLineApiError,
    StreamLineAuthenticationError,
    StreamLineCannotConnect,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

    from homeassistant.helpers.service_info.hassio import HassioServiceInfo

TOKEN_SELECTOR = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))


class StreamLineConfigFlow(ConfigFlow, domain=DOMAIN):
    """Configure a StreamLine bridge through Home Assistant."""

    VERSION = 1
    _discovery: HassioServiceInfo | None = None

    @override
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Configure a standalone or add-on bridge."""
        return await self._async_configure("user", user_input)

    @override
    async def async_step_hassio(self, discovery_info: HassioServiceInfo) -> ConfigFlowResult:
        """Offer the integration when the StreamLine add-on starts."""
        self._discovery = discovery_info
        await self.async_set_unique_id(discovery_info.uuid)
        self._abort_if_unique_id_configured()
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm a Supervisor-discovered add-on."""
        if user_input is None:
            return self.async_show_form(
                step_id="hassio_confirm",
                description_placeholders={
                    "addon": self._discovery.name if self._discovery else "StreamLine"
                },
            )
        assert self._discovery is not None
        return await self._async_create(
            self._discovered_data(self._discovery),
            title=self._discovery.name,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change bridge access details and verify them before reload."""
        entry = self._get_reconfigure_entry()
        if user_input is None:
            return self.async_show_form(
                step_id="reconfigure",
                data_schema=self._schema(entry.data),
            )
        data, errors = await self._validated_data(user_input)
        if errors:
            return self.async_show_form(
                step_id="reconfigure",
                data_schema=self._schema(user_input),
                errors=errors,
            )
        return self.async_update_reload_and_abort(entry, data_updates=data)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        """Replace a recording token rejected by the bridge."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Verify and save a replacement recording token."""
        entry = self._get_reauth_entry()
        if user_input is None:
            return self.async_show_form(
                step_id="reauth_confirm",
                data_schema=vol.Schema({vol.Required(CONF_RECORDING_TOKEN): TOKEN_SELECTOR}),
            )
        candidate = dict(entry.data)
        candidate[CONF_RECORDING_TOKEN] = user_input[CONF_RECORDING_TOKEN]
        data, errors = await self._validated_data(candidate)
        if errors:
            return self.async_show_form(
                step_id="reauth_confirm",
                data_schema=vol.Schema({vol.Required(CONF_RECORDING_TOKEN): TOKEN_SELECTOR}),
                errors=errors,
            )
        return self.async_update_reload_and_abort(entry, data_updates=data)

    async def _async_configure(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        if user_input is None:
            return self.async_show_form(step_id=step_id, data_schema=self._schema({}))
        return await self._async_create(user_input)

    async def _async_create(
        self, user_input: Mapping[str, Any], title: str | None = None
    ) -> ConfigFlowResult:
        data, errors = await self._validated_data(user_input)
        if errors:
            return self.async_show_form(
                step_id="user",
                data_schema=self._schema(user_input),
                errors=errors,
            )
        if self._discovery is None:
            self._async_abort_entries_match({CONF_BRIDGE_URL: data[CONF_BRIDGE_URL]})
        return self.async_create_entry(
            title=title or _entry_title(data[CONF_BRIDGE_URL]), data=data
        )

    async def _validated_data(
        self, user_input: Mapping[str, Any]
    ) -> tuple[dict[str, str], dict[str, str]]:
        try:
            bridge_url = normalize_bridge_url(str(user_input[CONF_BRIDGE_URL]))
        except KeyError, StreamLineApiError:
            return {}, {"base": "invalid_url"}
        token = str(user_input.get(CONF_RECORDING_TOKEN, "")).strip()
        client = StreamLineBridgeClient(
            async_get_clientsession(self.hass), bridge_url, token or None
        )
        try:
            await client.async_get_status()
            capabilities = await client.async_get_recording_capabilities()
            if capabilities.enabled and token:
                await client.async_get_recordings()
        except StreamLineAuthenticationError:
            return {}, {"base": "invalid_auth"}
        except StreamLineCannotConnect:
            return {}, {"base": "cannot_connect"}
        except StreamLineApiError:
            return {}, {"base": "invalid_response"}
        data = {CONF_BRIDGE_URL: bridge_url}
        if token:
            data[CONF_RECORDING_TOKEN] = token
        return data, {}

    @staticmethod
    def _schema(defaults: Mapping[str, Any]) -> vol.Schema:
        return vol.Schema(
            {
                vol.Required(
                    CONF_BRIDGE_URL,
                    default=defaults.get(CONF_BRIDGE_URL, "http://homeassistant.local:8088"),
                ): str,
                vol.Optional(
                    CONF_RECORDING_TOKEN,
                    default=defaults.get(CONF_RECORDING_TOKEN, ""),
                ): TOKEN_SELECTOR,
            }
        )

    @staticmethod
    def _discovered_data(discovery: HassioServiceInfo) -> dict[str, str]:
        host = str(discovery.config["host"])
        port = int(discovery.config["port"])
        data = {CONF_BRIDGE_URL: f"http://{host}:{port}"}
        token = discovery.config.get(CONF_RECORDING_TOKEN)
        if isinstance(token, str) and token:
            data[CONF_RECORDING_TOKEN] = token
        return data


def _entry_title(bridge_url: str) -> str:
    parsed = urlsplit(bridge_url)
    return parsed.hostname or bridge_url
