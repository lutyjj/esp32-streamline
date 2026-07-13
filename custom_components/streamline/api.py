"""Async client for the StreamLine bridge API."""

from __future__ import annotations

from contextlib import suppress
from http import HTTPStatus
from typing import TYPE_CHECKING

from aiohttp import ClientError, ClientTimeout
from pydantic import BaseModel, ValidationError
from yarl import URL

from .errors import (
    StreamLineApiError,
    StreamLineAuthenticationError,
    StreamLineCannotConnect,
)
from .models import (
    BridgeStatus,
    ErrorResponse,
    RecordingCapabilities,
    RecordingList,
    RecordingResult,
    RecordingSnapshot,
    StartRecordingRequest,
)

if TYPE_CHECKING:
    from aiohttp import ClientResponse, ClientSession

REQUEST_TIMEOUT = ClientTimeout(total=10)


class StreamLineBridgeClient:
    """Call the bridge API with Home Assistant's shared HTTP session."""

    def __init__(
        self,
        session: ClientSession,
        bridge_url: str,
        recording_token: str | None = None,
    ) -> None:
        self._session = session
        self._base_url = URL(normalize_bridge_url(bridge_url))
        self._recording_token = recording_token or None

    @property
    def bridge_url(self) -> str:
        """Return the normalized bridge root URL."""
        return str(self._base_url)

    @property
    def has_recording_token(self) -> bool:
        """Return whether authenticated recording calls are possible."""
        return self._recording_token is not None

    async def async_get_status(self) -> BridgeStatus:
        return await self._request("GET", "/status", BridgeStatus)

    async def async_get_recording_capabilities(self) -> RecordingCapabilities:
        return await self._request("GET", "/api/recordings/capabilities", RecordingCapabilities)

    async def async_get_recordings(self) -> RecordingList:
        return await self._request("GET", "/api/recordings", RecordingList, authenticated=True)

    async def async_start_recording(self, source: str, title: str) -> RecordingSnapshot:
        result = await self._request(
            "POST",
            "/api/recordings",
            RecordingResult,
            authenticated=True,
            body=StartRecordingRequest(source=source, title=title),
        )
        return result.recording

    async def async_stop_recording(self, recording_id: str) -> RecordingSnapshot:
        result = await self._request(
            "POST",
            f"/api/recordings/{recording_id}/stop",
            RecordingResult,
            authenticated=True,
        )
        return result.recording

    async def _request[ModelT: BaseModel](
        self,
        method: str,
        path: str,
        response_model: type[ModelT],
        *,
        authenticated: bool = False,
        body: BaseModel | None = None,
    ) -> ModelT:
        headers: dict[str, str] = {}
        if authenticated:
            if self._recording_token is None:
                raise StreamLineAuthenticationError("a recording token is required")
            headers["Authorization"] = f"Bearer {self._recording_token}"
        try:
            async with self._session.request(
                method,
                self._base_url.with_path(path),
                headers=headers,
                json=body.model_dump(mode="json") if body is not None else None,
                timeout=REQUEST_TIMEOUT,
            ) as response:
                if response.status >= HTTPStatus.BAD_REQUEST:
                    raise await _response_error(response)
                payload: object = await response.json(content_type=None)
        except StreamLineApiError:
            raise
        except (ClientError, TimeoutError) as exc:
            raise StreamLineCannotConnect("could not connect to the StreamLine bridge") from exc
        except ValueError as exc:
            raise StreamLineApiError("bridge returned invalid JSON") from exc
        return _validate(response_model, payload)


async def _response_error(response: ClientResponse) -> StreamLineApiError:
    """Map one bridge error response to the matching client error."""
    message = f"bridge request failed with HTTP {response.status}"
    with suppress(StreamLineApiError, ClientError, ValueError):
        message = _validate(ErrorResponse, await response.json(content_type=None)).error.message
    if response.status == HTTPStatus.UNAUTHORIZED:
        return StreamLineAuthenticationError(message)
    return StreamLineApiError(message)


def _validate[ModelT: BaseModel](model: type[ModelT], payload: object) -> ModelT:
    """Parse one bridge payload with its OpenAPI-generated model."""
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise StreamLineApiError(f"bridge returned an invalid {model.__name__}") from exc


def normalize_bridge_url(value: str) -> str:
    """Parse and canonicalize one bridge root URL."""
    try:
        url = URL(value.strip())
    except ValueError as exc:
        raise StreamLineApiError("enter a valid bridge URL") from exc
    if (
        url.scheme not in {"http", "https"}
        or url.host is None
        or url.user is not None
        or url.password is not None
        or url.query_string
        or url.fragment
        or url.path not in {"", "/"}
    ):
        raise StreamLineApiError("enter an HTTP or HTTPS bridge root URL without a path or query")
    return str(url.with_path("")).rstrip("/")
