"""Bridge client contract and boundary tests."""

import json
from pathlib import Path

import pytest
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer

from custom_components.streamline.api import StreamLineBridgeClient, normalize_bridge_url
from custom_components.streamline.errors import (
    StreamLineApiError,
    StreamLineAuthenticationError,
)

from .model_fixtures import recording_snapshot, source_snapshot


def source_payload() -> dict[str, object]:
    """Return a complete bridge source response."""
    return source_snapshot(peak=32768).model_dump(mode="json")


def recording_payload(recording_id: str = "recording-1") -> dict[str, object]:
    """Return a complete recording shape at the client boundary."""
    return recording_snapshot(recording_id=recording_id).model_dump(mode="json")


@pytest.mark.asyncio
async def test_client_validates_status_recordings_and_bearer_auth(
    socket_enabled: None,
) -> None:
    """One typed client owns all shared bridge parsing and authentication."""
    requested_authorization: list[str | None] = []

    async def status(_request: web.Request) -> web.Response:
        return web.json_response(
            {"bridge_version": "0.5.6", "sources": {"192.0.2.10": source_payload()}}
        )

    async def recordings(request: web.Request) -> web.Response:
        requested_authorization.append(request.headers.get("Authorization"))
        return web.json_response(
            {
                "active": [],
                "saved": [recording_payload()],
                "storage": {"free_bytes": 1024},
            }
        )

    app = web.Application()
    app.router.add_get("/status", status)
    app.router.add_get("/api/recordings", recordings)
    server = await _start_server(app)
    async with server, ClientSession() as session:
        client = StreamLineBridgeClient(session, str(server.make_url("/")), "secret-token")
        parsed_status = await client.async_get_status()
        parsed_recordings = await client.async_get_recordings()

    assert parsed_status.sources["192.0.2.10"].levels.peak_right == 32768
    assert parsed_recordings.saved[0].title == "Album side A"
    assert requested_authorization == ["Bearer secret-token"]


@pytest.mark.asyncio
async def test_client_rejects_unknown_state_and_unsafe_download_ticket(
    socket_enabled: None,
) -> None:
    """Malformed cross-boundary state and redirect-like tickets fail closed."""
    bad_source = source_payload()
    bad_source["lifecycle"] = {"state": "invented"}

    async def status(_request: web.Request) -> web.Response:
        return web.json_response({"bridge_version": "0.5.6", "sources": {"192.0.2.10": bad_source}})

    async def ticket(_request: web.Request) -> web.Response:
        return web.json_response({"url": "https://attacker.invalid/file", "expires_in_seconds": 60})

    app = web.Application()
    app.router.add_get("/status", status)
    app.router.add_post("/api/recordings/recording-1/download-ticket", ticket)
    server = await _start_server(app)
    async with server, ClientSession() as session:
        client = StreamLineBridgeClient(session, str(server.make_url("/")), "secret-token")
        with pytest.raises(StreamLineApiError, match="invalid bridge status"):
            await client.async_get_status()
        with pytest.raises(StreamLineApiError, match="unsafe"):
            await client.async_open_recording("recording-1")


@pytest.mark.asyncio
async def test_client_names_authentication_failure(socket_enabled: None) -> None:
    """A rejected recording token remains distinct from bridge availability."""

    async def recordings(_request: web.Request) -> web.Response:
        return web.json_response({"error": {}}, status=401)

    app = web.Application()
    app.router.add_get("/api/recordings", recordings)
    server = await _start_server(app)
    async with server, ClientSession() as session:
        client = StreamLineBridgeClient(session, str(server.make_url("/")), "wrong-token")
        with pytest.raises(StreamLineAuthenticationError):
            await client.async_get_recordings()


async def _start_server(app: web.Application) -> TestServer:
    server = TestServer(app)
    await server.start_server()
    return server


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("http://bridge.local:8088/", "http://bridge.local:8088"),
        (" https://bridge.example ", "https://bridge.example"),
    ],
)
def test_normalize_bridge_url_accepts_only_a_root(raw: str, expected: str) -> None:
    assert normalize_bridge_url(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "bridge.local",
        "ftp://bridge.local",
        "http://user@bridge.local",
        "http://bridge.local/status",
    ],
)
def test_normalize_bridge_url_rejects_ambiguous_or_credentialed_urls(raw: str) -> None:
    with pytest.raises(StreamLineApiError):
        normalize_bridge_url(raw)


def test_client_operations_match_the_generated_bridge_contract() -> None:
    """Keep the narrow HA transport pinned to bridge OpenAPI operations."""
    document = json.loads((Path(__file__).parents[2] / "docs/bridge-openapi.json").read_text())
    operations = {
        (method.upper(), path): operation["operationId"]
        for path, path_item in document["paths"].items()
        for method, operation in path_item.items()
        if method in {"get", "post", "delete"}
    }
    assert operations[("GET", "/status")] == "getBridgeStatus"
    assert operations[("GET", "/api/recordings/capabilities")] == "getRecordingCapabilities"
    assert operations[("GET", "/api/recordings")] == "getRecordings"
    assert operations[("POST", "/api/recordings")] == "startRecording"
    assert operations[("POST", "/api/recordings/{recording_id}/stop")] == "stopRecording"
    assert operations[("DELETE", "/api/recordings/{recording_id}")] == "deleteRecording"
    assert (
        operations[("POST", "/api/recordings/{recording_id}/download-ticket")]
        == "createRecordingDownloadTicket"
    )
