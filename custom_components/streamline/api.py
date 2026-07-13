"""Async transport client for the StreamLine bridge API."""

from __future__ import annotations

from http import HTTPStatus
from typing import TYPE_CHECKING

from aiohttp import ClientError, ClientResponse, ClientSession, ClientTimeout
from pydantic import BaseModel, ValidationError
from yarl import URL

from .errors import (
    StreamLineApiError,
    StreamLineAuthenticationError,
    StreamLineCannotConnect,
)
from .generated import (
    BridgeStatus,
    DeleteRecordingResult,
    DownloadTicket,
    ErrorResponse,
    RecordingCapabilities,
    RecordingList,
    RecordingResult,
    RecordingSnapshot,
    StartRecordingRequest,
)

if TYPE_CHECKING:
    from collections.abc import Mapping

REQUEST_TIMEOUT = ClientTimeout(total=10)


class StreamLineBridgeClient:
    """Call the bridge through Home Assistant's shared HTTP session."""

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
        """Return the normalized public bridge URL."""
        return str(self._base_url)

    @property
    def has_recording_token(self) -> bool:
        """Return whether authenticated recording calls are available."""
        return self._recording_token is not None

    async def async_get_status(self) -> BridgeStatus:
        return _validate(
            BridgeStatus,
            await self._request_json("GET", "/status"),
            "bridge status",
        )

    async def async_get_recording_capabilities(self) -> RecordingCapabilities:
        return _validate(
            RecordingCapabilities,
            await self._request_json("GET", "/api/recordings/capabilities"),
            "recording capabilities",
        )

    async def async_get_recordings(self) -> RecordingList:
        return _validate(
            RecordingList,
            await self._request_json("GET", "/api/recordings", authenticated=True),
            "recording list",
        )

    async def async_start_recording(self, source: str, title: str) -> RecordingSnapshot:
        request = StartRecordingRequest(source=source, title=title)
        result = _validate(
            RecordingResult,
            await self._request_json(
                "POST",
                "/api/recordings",
                authenticated=True,
                json_body=request.model_dump(mode="json"),
            ),
            "start recording result",
        )
        return result.recording

    async def async_stop_recording(self, recording_id: str) -> RecordingSnapshot:
        result = _validate(
            RecordingResult,
            await self._request_json(
                "POST",
                f"/api/recordings/{recording_id}/stop",
                authenticated=True,
            ),
            "stop recording result",
        )
        return result.recording

    async def async_delete_recording(self, recording_id: str) -> None:
        _validate(
            DeleteRecordingResult,
            await self._request_json(
                "DELETE",
                f"/api/recordings/{recording_id}",
                authenticated=True,
            ),
            "delete recording result",
        )

    async def async_open_recording(self, recording_id: str) -> ClientResponse:
        """Mint a ticket and open its WAV response for the Home Assistant proxy."""
        ticket = _validate(
            DownloadTicket,
            await self._request_json(
                "POST",
                f"/api/recordings/{recording_id}/download-ticket",
                authenticated=True,
            ),
            "recording ticket",
        )
        ticket_url = URL(ticket.url)
        if ticket_url.is_absolute() or not ticket_url.path.startswith("/api/recordings/"):
            raise StreamLineApiError("bridge returned an unsafe recording ticket URL")
        try:
            response = await self._session.get(
                self._base_url.join(ticket_url),
                allow_redirects=False,
                timeout=REQUEST_TIMEOUT,
            )
        except (ClientError, TimeoutError) as exc:
            raise StreamLineCannotConnect("could not open the bridge recording") from exc
        if response.status != HTTPStatus.OK:
            error = await self._response_error(response)
            response.release()
            raise error
        return response

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        authenticated: bool = False,
        json_body: Mapping[str, object] | None = None,
    ) -> object:
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
                json=json_body,
                timeout=REQUEST_TIMEOUT,
            ) as response:
                if response.status == HTTPStatus.UNAUTHORIZED:
                    raise StreamLineAuthenticationError(
                        "the bridge rejected the recording token",
                        status=response.status,
                    )
                if response.status >= HTTPStatus.BAD_REQUEST:
                    raise await self._response_error(response)
                try:
                    return await response.json(content_type=None)
                except (ValueError, ClientError) as exc:
                    raise StreamLineApiError("bridge returned invalid JSON") from exc
        except StreamLineApiError:
            raise
        except (ClientError, TimeoutError) as exc:
            raise StreamLineCannotConnect("could not connect to the StreamLine bridge") from exc

    @staticmethod
    async def _response_error(response: ClientResponse) -> StreamLineApiError:
        message = f"bridge request failed with HTTP {response.status}"
        try:
            payload = _validate(
                ErrorResponse,
                await response.json(content_type=None),
                "bridge error",
            )
            message = payload.error.message
        except StreamLineApiError, ValueError, ClientError:
            pass
        if response.status == HTTPStatus.UNAUTHORIZED:
            return StreamLineAuthenticationError(message, status=response.status)
        return StreamLineApiError(message, status=response.status)


def normalize_bridge_url(value: str) -> str:
    """Normalize one direct HTTP bridge root URL."""
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
        raise StreamLineApiError(
            "enter an HTTP or HTTPS bridge root URL without credentials, a path, or a query"
        )
    return str(url.with_path("")).rstrip("/")


def _validate[ModelT: BaseModel](model: type[ModelT], value: object, name: str) -> ModelT:
    """Validate a bridge value with its OpenAPI-generated model."""
    try:
        return model.model_validate(value)
    except ValidationError as exc:
        raise StreamLineApiError(f"bridge returned invalid {name}") from exc
