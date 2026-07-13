"""Contract tests for the bridge API client."""

from __future__ import annotations

import json
from pathlib import Path
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
    recording_capabilities,
    recording_list,
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


async def test_every_client_operation_matches_the_openapi_contract(
    hass: HomeAssistant, aioclient_mock: AiohttpClientMocker
) -> None:
    """Pin the client's hand-written method, path, and auth facts to the artifact.

    The response models are generated from docs/bridge-openapi.json; this test
    mechanically checks the remaining copies so a contract change fails here
    instead of at runtime.
    """
    spec = json.loads((Path(__file__).parents[2] / "docs" / "bridge-openapi.json").read_text())
    recording_id = "rec-1"
    aioclient_mock.get(f"{BRIDGE_URL}/status", json=bridge_status())
    aioclient_mock.get(f"{BRIDGE_URL}/api/recordings/capabilities", json=recording_capabilities())
    aioclient_mock.get(f"{BRIDGE_URL}/api/recordings", json=recording_list())
    aioclient_mock.post(f"{BRIDGE_URL}/api/recordings", json=recording_result(recording_snapshot()))
    aioclient_mock.post(
        f"{BRIDGE_URL}/api/recordings/{recording_id}/stop",
        json=recording_result(recording_snapshot()),
    )

    bridge = client(hass, TOKEN)
    await bridge.async_get_status()
    await bridge.async_get_recording_capabilities()
    await bridge.async_get_recordings()
    await bridge.async_start_recording(SOURCE, "Test recording")
    await bridge.async_stop_recording(recording_id)
    exercised = {
        "async_get_status",
        "async_get_recording_capabilities",
        "async_get_recordings",
        "async_start_recording",
        "async_stop_recording",
    }

    public = {name for name in dir(StreamLineBridgeClient) if name.startswith("async_")}
    assert public == exercised, "every public client operation must be exercised here"

    assert aioclient_mock.mock_calls
    for method, url, _body, headers in aioclient_mock.mock_calls:
        path = url.path.replace(recording_id, "{recording_id}")
        operation = spec["paths"][path][method.lower()]
        requires_bearer = any("bearer_auth" in s for s in operation.get("security") or [])
        assert ("Authorization" in (headers or {})) == requires_bearer, (method, path)


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
