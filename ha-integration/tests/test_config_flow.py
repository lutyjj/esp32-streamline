"""Config-flow tests for manual, discovered, duplicate, and failed setup."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from pytest_homeassistant_custom_component.common import (  # type: ignore[import-untyped]
    MockConfigEntry,
)

from custom_components.streamline.const import (
    CONF_BRIDGE_URL,
    CONF_RECORDING_TOKEN,
    DOMAIN,
)
from custom_components.streamline.errors import StreamLineAuthenticationError

from .model_fixtures import bridge_status, recording_capabilities

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant


@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recordings",
    new_callable=AsyncMock,
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recording_capabilities",
    new_callable=AsyncMock,
    return_value=recording_capabilities(),
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_status",
    new_callable=AsyncMock,
    return_value=bridge_status(),
)
async def test_manual_flow_verifies_and_normalizes_bridge(
    _status: AsyncMock,
    _capabilities: AsyncMock,
    recordings: AsyncMock,
    hass: HomeAssistant,
) -> None:
    """Manual setup validates both open status and optional recording auth."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            CONF_BRIDGE_URL: "http://bridge.local:8088/",
            CONF_RECORDING_TOKEN: "recording-token",
        },
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "bridge.local"
    assert result["data"] == {
        CONF_BRIDGE_URL: "http://bridge.local:8088",
        CONF_RECORDING_TOKEN: "recording-token",
    }
    assert recordings.await_count >= 1


@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recording_capabilities",
    new_callable=AsyncMock,
    return_value=recording_capabilities(enabled=False),
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_status",
    new_callable=AsyncMock,
    return_value=bridge_status(),
)
async def test_exact_manual_url_cannot_be_configured_twice(
    _status: AsyncMock, _capabilities: AsyncMock, hass: HomeAssistant
) -> None:
    """A bridge URL maps to at most one manual config entry."""
    MockConfigEntry(
        domain=DOMAIN,
        title="bridge.local",
        data={CONF_BRIDGE_URL: "http://bridge.local:8088"},
    ).add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
        data={CONF_BRIDGE_URL: "http://bridge.local:8088", CONF_RECORDING_TOKEN: ""},
    )

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"


@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recordings",
    new_callable=AsyncMock,
    side_effect=StreamLineAuthenticationError("bad token"),
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recording_capabilities",
    new_callable=AsyncMock,
    return_value=recording_capabilities(),
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_status",
    new_callable=AsyncMock,
    return_value=bridge_status(),
)
async def test_rejected_recording_token_stays_on_the_form(
    _status: AsyncMock,
    _capabilities: AsyncMock,
    _recordings: AsyncMock,
    hass: HomeAssistant,
) -> None:
    """Bad recording credentials never create a partially useful entry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
        data={
            CONF_BRIDGE_URL: "http://bridge.local:8088",
            CONF_RECORDING_TOKEN: "wrong",
        },
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recordings",
    new_callable=AsyncMock,
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_recording_capabilities",
    new_callable=AsyncMock,
    return_value=recording_capabilities(),
)
@patch(
    "custom_components.streamline.config_flow.StreamLineBridgeClient.async_get_status",
    new_callable=AsyncMock,
    return_value=bridge_status(),
)
async def test_supervisor_discovery_requires_confirmation_and_keeps_its_uuid(
    _status: AsyncMock,
    _capabilities: AsyncMock,
    _recordings: AsyncMock,
    hass: HomeAssistant,
) -> None:
    """Add-on discovery removes host/token entry but never auto-configures."""
    discovery = HassioServiceInfo(
        config={
            "host": "streamline-addon",
            "port": 8088,
            CONF_RECORDING_TOKEN: "recording-token",
        },
        name="ESP32 StreamLine Bridge",
        slug="streamline_bridge",
        uuid="discovery-uuid",
    )
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_HASSIO}, data=discovery
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {
        CONF_BRIDGE_URL: "http://streamline-addon:8088",
        CONF_RECORDING_TOKEN: "recording-token",
    }
    assert result["result"].unique_id == "discovery-uuid"
