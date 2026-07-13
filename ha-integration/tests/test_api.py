"""Contract tests for the bridge API client."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest
from aiohttp import ClientConnectionError
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from custom_components.streamline.api import StreamLineBridgeClient, normalize_bridge_url
from custom_components.streamline.errors import (
    StreamLineApiError,
    StreamLineAuthenticationError,
    StreamLineCannotConnect,
)

from .bridge_payloads import (
    BRIDGE_URL,
    SOURCE,
    bridge_status,
    error_response,
    recording_result,
    recording_snapshot,
)

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker

TOKEN = "recording-token-1234"


def client(hass: HomeAssistant, token: str | None = None) -> StreamLineBridgeClient:
    return StreamLineBridgeClient(async_get_clientsession(hass), BRIDGE_URL, token)


async def test_status_parses_into_the_generated_model(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(f"{BRIDGE_URL}/status", json=bridge_status())

    status = await client(hass).async_get_status()

    assert status.sources[SOURCE].lifecycle.state == "connected"


async def test_start_recording_sends_the_bearer_token_and_request_body(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(f"{BRIDGE_URL}/api/recordings", json=recording_result(recording_snapshot()))

    recording = await client(hass, TOKEN).async_start_recording(SOURCE, "Test recording")

    assert recording.id == "rec-1"
    method, _url, body, headers = aioclient_mock.mock_calls[0]
    assert method == "POST"
    assert body == {"source": SOURCE, "title": "Test recording"}
    assert headers["Authorization"] == f"Bearer {TOKEN}"


async def test_authenticated_call_without_token_fails_before_any_request(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    with pytest.raises(StreamLineAuthenticationError):
        await client(hass).async_get_recordings()

    assert not aioclient_mock.mock_calls


async def test_unauthorized_response_maps_to_an_authentication_error(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(
        f"{BRIDGE_URL}/api/recordings",
        status=401,
        json=error_response("unauthorized", "Enter the recording token configured on this bridge."),
    )

    with pytest.raises(StreamLineAuthenticationError, match="Enter the recording token"):
        await client(hass, TOKEN).async_get_recordings()


async def test_bridge_error_message_reaches_the_caller(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.post(
        f"{BRIDGE_URL}/api/recordings",
        status=503,
        json=error_response("recording-disabled", "Recording storage is not configured."),
    )

    with pytest.raises(StreamLineApiError, match="Recording storage is not configured"):
        await client(hass, TOKEN).async_start_recording(SOURCE, "Test recording")


async def test_connection_failure_maps_to_cannot_connect(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(f"{BRIDGE_URL}/status", exc=ClientConnectionError("refused"))

    with pytest.raises(StreamLineCannotConnect):
        await client(hass).async_get_status()


async def test_unexpected_payload_shape_is_an_api_error(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(f"{BRIDGE_URL}/status", json={"unexpected": True})

    with pytest.raises(StreamLineApiError, match="invalid BridgeStatus"):
        await client(hass).async_get_status()


async def test_non_json_body_is_an_api_error(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    aioclient_mock.get(f"{BRIDGE_URL}/status", text="<html>proxy error</html>")

    with pytest.raises(StreamLineApiError, match="invalid JSON"):
        await client(hass).async_get_status()


def test_normalize_bridge_url_canonicalizes_the_root() -> None:
    assert normalize_bridge_url(" http://bridge.local:8088/ ") == "http://bridge.local:8088"


@pytest.mark.parametrize(
    "value",
    [
        "",
        "bridge.local:8088",
        "ftp://bridge.local",
        "http://user:secret@bridge.local:8088",
        "http://bridge.local:8088/api",
        "http://bridge.local:8088?token=x",
        "http://bridge.local:8088#status",
    ],
)
def test_normalize_bridge_url_rejects_non_root_urls(value: str) -> None:
    with pytest.raises(StreamLineApiError):
        normalize_bridge_url(value)
