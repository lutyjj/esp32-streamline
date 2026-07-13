"""Entity, action, and dynamic-source tests for StreamLine."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

from homeassistant.const import ATTR_ENTITY_ID, SERVICE_TURN_ON, STATE_ON
from pytest_homeassistant_custom_component.common import (  # type: ignore[import-untyped]
    MockConfigEntry,
)

from custom_components.streamline.const import (
    ATTR_CONFIG_ENTRY_ID,
    ATTR_SOURCE,
    ATTR_TITLE,
    CONF_BRIDGE_URL,
    CONF_RECORDING_TOKEN,
    DOMAIN,
    SERVICE_DELETE_RECORDING,
    SERVICE_START_RECORDING,
    SERVICE_STOP_RECORDING,
)

from .model_fixtures import (
    bridge_status,
    recording_capabilities,
    recording_list,
    recording_snapshot,
    source_snapshot,
)

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from custom_components.streamline.generated import RecordingSnapshot, SourceSnapshot


def source(*, peak: int = 16384) -> SourceSnapshot:
    return source_snapshot(peak=peak)


def active_recording() -> RecordingSnapshot:
    return recording_snapshot(state="recording", file_name=None)


async def setup_entry(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Bridge",
        data={
            CONF_BRIDGE_URL: "http://bridge.local:8088",
            CONF_RECORDING_TOKEN: "recording-token",
        },
    )
    entry.add_to_hass(hass)
    with (
        patch(
            "custom_components.streamline.api.StreamLineBridgeClient.async_get_status",
            new_callable=AsyncMock,
            return_value=bridge_status({"192.0.2.10": source()}),
        ),
        patch(
            "custom_components.streamline.api.StreamLineBridgeClient.async_get_recording_capabilities",
            new_callable=AsyncMock,
            return_value=recording_capabilities(),
        ),
        patch(
            "custom_components.streamline.api.StreamLineBridgeClient.async_get_recordings",
            new_callable=AsyncMock,
            return_value=recording_list(),
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return entry


async def test_setup_creates_streaming_level_and_recording_entities(
    hass: HomeAssistant,
) -> None:
    """Issue #105's state and control surface comes from one coordinator."""
    await setup_entry(hass)

    streaming = hass.states.get("binary_sensor.streamline_source_192_0_2_10_audio_streaming")
    peak = hass.states.get("sensor.streamline_source_192_0_2_10_peak_level")
    recording = hass.states.get("switch.streamline_source_192_0_2_10_recording")

    assert streaming is not None and streaming.state == STATE_ON
    assert peak is not None and peak.state == "50.0"
    assert recording is not None and recording.state == "off"


async def test_new_bridge_source_adds_entities_without_reload(hass: HomeAssistant) -> None:
    """Sources discovered after setup become Home Assistant devices."""
    entry = await setup_entry(hass)
    coordinator = entry.runtime_data
    coordinator.async_set_updated_data(
        coordinator.data.__class__(
            bridge_status(
                {
                    "192.0.2.10": source(),
                    "192.0.2.11": source(peak=32768),
                },
            ),
            coordinator.data.capabilities,
            coordinator.data.recordings,
        )
    )
    await hass.async_block_till_done()

    assert hass.states.get("binary_sensor.streamline_source_192_0_2_11_audio_streaming") is not None
    peak = hass.states.get("sensor.streamline_source_192_0_2_11_peak_level")
    assert peak is not None and peak.state == "100.0"


async def test_recording_switch_and_named_action_call_the_same_api(
    hass: HomeAssistant,
) -> None:
    """Dashboards get a switch while automations retain a programmable title."""
    entry = await setup_entry(hass)
    coordinator = entry.runtime_data
    coordinator.async_start_recording = AsyncMock(return_value=active_recording())

    await hass.services.async_call(
        "switch",
        SERVICE_TURN_ON,
        {ATTR_ENTITY_ID: "switch.streamline_source_192_0_2_10_recording"},
        blocking=True,
    )
    await hass.services.async_call(
        DOMAIN,
        SERVICE_START_RECORDING,
        {
            ATTR_CONFIG_ENTRY_ID: entry.entry_id,
            ATTR_SOURCE: "192.0.2.10",
            ATTR_TITLE: "Album side A",
        },
        blocking=True,
    )

    assert coordinator.async_start_recording.await_count == 2
    assert coordinator.async_start_recording.await_args_list[1].args == (
        "192.0.2.10",
        "Album side A",
    )


async def test_stop_and_delete_actions_call_the_recording_api(
    hass: HomeAssistant,
) -> None:
    """Automations can finish and remove recordings by stable bridge ID."""
    entry = await setup_entry(hass)
    coordinator = entry.runtime_data
    coordinator.async_stop_recording = AsyncMock(return_value=active_recording())
    coordinator.async_delete_recording = AsyncMock(return_value=None)

    for action in (SERVICE_STOP_RECORDING, SERVICE_DELETE_RECORDING):
        await hass.services.async_call(
            DOMAIN,
            action,
            {
                ATTR_CONFIG_ENTRY_ID: entry.entry_id,
                "recording_id": "recording-1",
            },
            blocking=True,
        )

    coordinator.async_stop_recording.assert_awaited_once_with("recording-1")
    coordinator.async_delete_recording.assert_awaited_once_with("recording-1")
