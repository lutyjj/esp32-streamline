"""Authenticated HTTP contract for bridge recordings."""

from __future__ import annotations

import hmac
import json
import re
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import TYPE_CHECKING

from streamline_bridge.recording import RecordingError, recording_capabilities

if TYPE_CHECKING:
    from pathlib import Path

    from streamline_bridge.recording import RecordingService

RECORDINGS_PATH = "/api/recordings"
CAPABILITIES_PATH = f"{RECORDINGS_PATH}/capabilities"
RECORDING_ACTION = re.compile(r"^/api/recordings/([a-zA-Z0-9-]+)/(stop|file)$")
RECORDING_ITEM = re.compile(r"^/api/recordings/([a-zA-Z0-9-]+)$")


@dataclass(frozen=True)
class JsonResponse:
    status: HTTPStatus
    data: dict[str, object]
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class FileResponse:
    path: Path


RecordingResponse = JsonResponse | FileResponse


class RecordingHttpController:
    """Route recording requests without owning sockets or files."""

    def __init__(self, service: RecordingService | None, token: str | None) -> None:
        self._service = service
        self._token = token

    def handle(
        self,
        method: str,
        path: str,
        authorization: str | None,
        body: bytes = b"",
    ) -> RecordingResponse | None:
        if path == CAPABILITIES_PATH:
            if method != "GET":
                return self._method_not_allowed("GET")
            capabilities = self._service.capabilities() if self._service is not None else recording_capabilities(False)
            return JsonResponse(HTTPStatus.OK, capabilities)
        if path != RECORDINGS_PATH and not path.startswith(f"{RECORDINGS_PATH}/"):
            return None
        unauthorized = self._authorize(authorization)
        if unauthorized is not None:
            return unauthorized
        if self._service is None:
            return self._error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "recording-disabled",
                "Recording is disabled. Configure writable recording storage and restart the bridge.",
            )
        try:
            return self._handle_enabled(method, path, body)
        except RecordingError as exc:
            return self._recording_error(exc)

    def _handle_enabled(self, method: str, path: str, body: bytes) -> RecordingResponse:
        assert self._service is not None
        if path == RECORDINGS_PATH:
            if method == "GET":
                return JsonResponse(HTTPStatus.OK, self._service.list())
            if method == "POST":
                data = self._json_object(body)
                source = data.get("source")
                title = data.get("title")
                if not isinstance(source, str) or not isinstance(title, str):
                    raise RecordingError("invalid-request", "Provide string fields named source and title.")
                return JsonResponse(HTTPStatus.CREATED, {"recording": self._service.start(source, title)})
            return self._method_not_allowed("GET, POST")
        action = RECORDING_ACTION.fullmatch(path)
        if action is not None:
            recording_id, operation = action.groups()
            if operation == "stop":
                if method != "POST":
                    return self._method_not_allowed("POST")
                return JsonResponse(HTTPStatus.OK, {"recording": self._service.stop(recording_id)})
            if method != "GET":
                return self._method_not_allowed("GET")
            return FileResponse(self._service.file(recording_id))
        item = RECORDING_ITEM.fullmatch(path)
        if item is not None:
            if method != "DELETE":
                return self._method_not_allowed("DELETE")
            recording_id = item.group(1)
            self._service.delete(recording_id)
            return JsonResponse(HTTPStatus.OK, {"deleted": recording_id})
        return self._error(HTTPStatus.NOT_FOUND, "not-found", "Recording endpoint not found. Refresh the page.")

    def _authorize(self, authorization: str | None) -> JsonResponse | None:
        expected = self._token
        supplied = authorization.removeprefix("Bearer ") if authorization is not None else ""
        if expected and hmac.compare_digest(supplied.encode(), expected.encode()):
            return None
        return self._error(
            HTTPStatus.UNAUTHORIZED,
            "unauthorized",
            "Enter the recording token configured on this bridge.",
            {"WWW-Authenticate": 'Bearer realm="StreamLine recordings"'},
        )

    @staticmethod
    def _json_object(body: bytes) -> dict[str, object]:
        try:
            data = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RecordingError("invalid-request", "Send a valid JSON request body.") from exc
        if not isinstance(data, dict):
            raise RecordingError("invalid-request", "Send a JSON object.")
        return data

    @staticmethod
    def _method_not_allowed(allow: str) -> JsonResponse:
        return RecordingHttpController._error(
            HTTPStatus.METHOD_NOT_ALLOWED,
            "method-not-allowed",
            "This recording endpoint does not support that method.",
            {"Allow": allow},
        )

    @staticmethod
    def _recording_error(exc: RecordingError) -> JsonResponse:
        status = {
            "invalid-request": HTTPStatus.BAD_REQUEST,
            "invalid-title": HTTPStatus.BAD_REQUEST,
            "invalid-source": HTTPStatus.BAD_REQUEST,
            "not-found": HTTPStatus.NOT_FOUND,
            "not-active": HTTPStatus.CONFLICT,
            "source-busy": HTTPStatus.CONFLICT,
            "recording-active": HTTPStatus.CONFLICT,
            "storage-full": HTTPStatus.INSUFFICIENT_STORAGE,
            "storage-unavailable": HTTPStatus.INSUFFICIENT_STORAGE,
        }.get(exc.code, HTTPStatus.INTERNAL_SERVER_ERROR)
        return RecordingHttpController._error(status, exc.code, exc.message)

    @staticmethod
    def _error(
        status: HTTPStatus,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
    ) -> JsonResponse:
        return JsonResponse(status, {"error": {"code": code, "message": message}}, headers or {})
