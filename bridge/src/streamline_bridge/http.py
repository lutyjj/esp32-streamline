"""FastAPI adapter for bridge control, recordings, and WAV delivery."""

from __future__ import annotations

import hmac
import queue
import re
import secrets
import struct
from importlib.resources import files
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request, Security
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from streamline_bridge.api_models import (
    BridgeStatus,
    DeleteRecordingResult,
    DownloadTicket,
    ErrorDetail,
    ErrorResponse,
    RecordingCapabilities,
    RecordingList,
    RecordingResult,
    StartRecordingRequest,
    TransportKeyDeleteResult,
    TransportKeyRequest,
    TransportKeyResult,
    TransportModeRequest,
    TransportSnapshot,
    UnlockResult,
)
from streamline_bridge.protocol import DEFAULT_FORMAT, PcmFormat
from streamline_bridge.recording import RecordingError
from streamline_bridge.recording_http import RecordingHttpService
from streamline_bridge.sources import Source, SourceRegistry, SourceSelectionError
from streamline_bridge.transport import DEFAULT_PORT, TransportControl

if TYPE_CHECKING:
    from collections.abc import Generator, Iterator, Mapping

    from streamline_bridge.pipeline import AudioPipeline
    from streamline_bridge.recording import RecordingService

HTTP_MAX_BATCH_CHUNKS = 64
HTTP_MAX_JSON_BODY_BYTES = 4096
DEFAULT_MAX_HTTP_CONNECTIONS = 32
DEFAULT_HTTP_REQUEST_TIMEOUT_SECONDS = 10.0
CONSOLE_PAGE = files("streamline_bridge").joinpath("console.html").read_bytes()
INGRESS_BASE_PATTERN = re.compile(r"(?:/[A-Za-z0-9._~-]+)*")
RECORDING_ID_PATTERN = r"^[a-zA-Z0-9-]+$"
TRANSPORT_KEY_ID_PATTERN = r"^eli1-[0-9a-f]{32}$"
RecordingId = Annotated[str, Path(pattern=RECORDING_ID_PATTERN)]
TransportKeyId = Annotated[str, Path(pattern=TRANSPORT_KEY_ID_PATTERN)]
bearer = HTTPBearer(auto_error=False, scheme_name="bearer_auth")


def error_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    return {status: {"model": ErrorResponse} for status in statuses}


class BridgeApi(FastAPI):
    """Publish the adapter's 400 validation envelope in generated OpenAPI."""

    def openapi(self) -> dict[str, Any]:
        schema = super().openapi()
        for path in schema.get("paths", {}).values():
            for operation in path.values():
                responses = operation.get("responses")
                if not isinstance(responses, dict) or "422" not in responses:
                    continue
                responses.pop("422")
                responses.setdefault(
                    "400",
                    {
                        "description": "Invalid request",
                        "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorResponse"}}},
                    },
                )
        return schema


class BodyLimitMiddleware(BaseHTTPMiddleware):
    """Reject declared request bodies above the bridge resource bound."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        raw_length = request.headers.get("content-length")
        try:
            length = int(raw_length) if raw_length is not None else 0
        except ValueError:
            length = HTTP_MAX_JSON_BODY_BYTES + 1
        if length > HTTP_MAX_JSON_BODY_BYTES:
            return error_response(413, "request-too-large", "Request bodies must not exceed 4096 bytes.")
        return await call_next(request)


def wav_header(pcm_format: PcmFormat = DEFAULT_FORMAT) -> bytes:
    """Build a WAV header with an unknown-length PCM data chunk."""
    block_align = pcm_format.channels * pcm_format.bits // 8
    byte_rate = pcm_format.rate * block_align
    unknown_size = 0xFFFFFFFF
    return b"".join(
        (
            b"RIFF",
            struct.pack("<I", unknown_size),
            b"WAVE",
            b"fmt ",
            struct.pack(
                "<IHHIIHH", 16, 1, pcm_format.channels, pcm_format.rate, byte_rate, block_align, pcm_format.bits
            ),
            b"data",
            struct.pack("<I", unknown_size),
        )
    )


def collect_http_batch(client_queue: queue.Queue[bytes | None]) -> list[bytes] | None:
    first = client_queue.get()
    if first is None:
        return None
    chunks = [first]
    while len(chunks) < HTTP_MAX_BATCH_CHUNKS:
        try:
            chunk = client_queue.get_nowait()
        except queue.Empty:
            break
        if chunk is None:
            return None
        chunks.append(chunk)
    return chunks


def error_response(status: int, code: str, message: str, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        ErrorResponse(error=ErrorDetail(code=code, message=message)).model_dump(),
        status_code=status,
        headers=headers,
    )


def recording_error(exc: RecordingError) -> JSONResponse:
    status = {
        "invalid-request": 400,
        "invalid-title": 400,
        "invalid-source": 400,
        "unauthorized": 401,
        "not-found": 404,
        "not-active": 409,
        "source-busy": 409,
        "recording-active": 409,
        "recording-disabled": 503,
        "storage-full": 507,
        "storage-unavailable": 507,
    }.get(exc.code, 500)
    return error_response(status, exc.code, exc.message)


def stream_wav_body(
    sources: SourceRegistry[AudioPipeline], source: Source[AudioPipeline], remote_addr: str, path: str
) -> Generator[bytes]:
    """Yield one WAV client stream and release all lifecycle state on close."""
    sources.retain_http(source)
    stream = source.hub.register_client(remote_addr, path)
    try:
        yield wav_header()
        while (chunks := collect_http_batch(stream.queue)) is not None:
            body = b"".join(chunks)
            yield body
            source.hub.record_client_write(stream.stats.id, len(body), len(chunks))
    finally:
        source.hub.unregister_client(stream.stats.id)
        sources.release_http(source)


def make_app(
    sources: SourceRegistry[AudioPipeline],
    bridge_version: str,
    recordings: RecordingService | None = None,
    api_token: str | None = None,
    transport: TransportControl | None = None,
) -> FastAPI:
    """Build the runtime app whose routes and models own the OpenAPI contract."""
    app = BridgeApi(
        title="StreamLine bridge API",
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(BodyLimitMiddleware)
    recording_api = RecordingHttpService(recordings)
    if transport is None:
        transport = TransportControl(None, None, port=DEFAULT_PORT)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_request: Request, exc: RequestValidationError) -> JSONResponse:
        message = exc.errors()[0].get("msg", "Request does not match the API contract.")
        return error_response(400, "invalid-request", str(message))

    def authorize(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Security(bearer)],
    ) -> None:
        if api_token is None:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "control-disabled",
                    "message": "No bridge API token is set. Add api_token to the add-on configuration "
                    "(or set STREAMLINE_API_TOKEN), then restart the bridge.",
                },
            )
        if (
            credentials is None
            or credentials.scheme != "Bearer"
            or not hmac.compare_digest(credentials.credentials.encode(), api_token.encode())
        ):
            raise HTTPException(
                status_code=401,
                detail={"code": "unauthorized", "message": "Enter the bridge API token configured on this bridge."},
                headers={"WWW-Authenticate": 'Bearer realm="StreamLine bridge"'},
            )

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        raw_detail: object = exc.detail
        detail = raw_detail if isinstance(raw_detail, dict) else {"code": "http-error", "message": str(raw_detail)}
        return error_response(exc.status_code, str(detail["code"]), str(detail["message"]), exc.headers)

    @app.get(
        "/status",
        response_model=BridgeStatus,
        operation_id="getBridgeStatus",
        summary="Read bridge and source status",
    )
    def get_status() -> BridgeStatus:
        return BridgeStatus.model_validate(
            {
                "bridge_version": bridge_version,
                "api_token_configured": api_token is not None,
                "sources": sources.snapshot(),
                "transport": transport.snapshot(),
            }
        )

    @app.get("/health", response_class=PlainTextResponse, operation_id="getBridgeHealth", summary="Check bridge health")
    def get_health() -> str:
        return "ok\n"

    @app.get(
        "/api/transport",
        response_model=TransportSnapshot,
        operation_id="getTransport",
        summary="Read PCM transport listeners, key ids, and authentication counters",
    )
    def get_transport() -> TransportSnapshot:
        return TransportSnapshot.model_validate(transport.snapshot())

    authenticated = [Depends(authorize)]
    transport_disabled_message = (
        "Transport control is disabled. Configure --transport-state-file, then restart the bridge."
    )

    @app.post(
        "/api/unlock",
        response_model=UnlockResult,
        responses=error_responses(401, 503),
        dependencies=authenticated,
        operation_id="unlockBridge",
        summary="Check the bridge API token",
    )
    def unlock() -> UnlockResult:
        return UnlockResult(ok=True)

    @app.put(
        "/api/transport/mode",
        response_model=TransportSnapshot,
        responses=error_responses(400, 401, 503),
        dependencies=authenticated,
        operation_id="setTransportMode",
        summary="Select the PCM listener mode, dropping live producers on a change",
    )
    def set_transport_mode(body: TransportModeRequest) -> Response | TransportSnapshot:
        if not transport.configurable:
            return error_response(503, "transport-unavailable", transport_disabled_message)
        transport.set_tls_enabled(body.mode == "tls-psk")
        return TransportSnapshot.model_validate(transport.snapshot())

    @app.put(
        "/api/transport/keys/{key_id}",
        response_model=TransportKeyResult,
        responses=error_responses(400, 401, 409, 503),
        status_code=201,
        dependencies=authenticated,
        operation_id="putTransportKey",
        summary="Provision or replace one device PCM transport key",
    )
    def put_transport_key(key_id: TransportKeyId, body: TransportKeyRequest) -> Response | TransportKeyResult:
        if transport.store is None:
            return error_response(503, "transport-unavailable", transport_disabled_message)
        try:
            transport.store.put(key_id, body.psk)
        except ValueError as exc:
            return error_response(409, "transport-key-rejected", str(exc))
        return TransportKeyResult(key_id=key_id)

    @app.delete(
        "/api/transport/keys/{key_id}",
        response_model=TransportKeyDeleteResult,
        responses=error_responses(400, 401, 404, 503),
        dependencies=authenticated,
        operation_id="deleteTransportKey",
        summary="Remove one device PCM transport key",
    )
    def delete_transport_key(key_id: TransportKeyId) -> Response | TransportKeyDeleteResult:
        if transport.store is None:
            return error_response(503, "transport-unavailable", transport_disabled_message)
        try:
            transport.store.delete(key_id)
        except ValueError as exc:
            return error_response(404, "transport-key-not-found", str(exc))
        return TransportKeyDeleteResult(deleted=key_id)

    @app.get(
        "/streamline.wav",
        response_class=StreamingResponse,
        responses={200: {"content": {"audio/wav": {}}}, 400: {"model": ErrorResponse}, 404: {"model": ErrorResponse}},
        operation_id="streamWav",
        summary="Stream live PCM as WAV",
    )
    def stream_wav(request: Request, source: str | None = Query(default=None)) -> Response:
        try:
            selected = sources.select(source)
        except SourceSelectionError as exc:
            return error_response(int(exc.status), "invalid-source", exc.message)
        remote = request.client.host if request.client is not None else "unknown"
        return StreamingResponse(
            stream_wav_body(sources, selected, remote, str(request.url.path)),
            media_type="audio/wav",
            headers={"Cache-Control": "no-store", "Connection": "close"},
        )

    @app.get(
        "/api/recordings/capabilities",
        response_model=RecordingCapabilities,
        operation_id="getRecordingCapabilities",
        summary="Read recording availability and limits",
    )
    def get_recording_capabilities() -> RecordingCapabilities:
        return RecordingCapabilities.model_validate(recording_api.capabilities())

    @app.get(
        "/api/recordings",
        response_model=RecordingList,
        responses=error_responses(401, 503),
        dependencies=authenticated,
        operation_id="getRecordings",
        summary="List active and saved recordings",
    )
    def get_recordings() -> Response | RecordingList:
        try:
            return RecordingList.model_validate(recording_api.list())
        except RecordingError as exc:
            return recording_error(exc)

    @app.post(
        "/api/recordings",
        response_model=RecordingResult,
        responses=error_responses(400, 401, 409, 503, 507),
        status_code=201,
        dependencies=authenticated,
        operation_id="startRecording",
        summary="Start a recording",
    )
    def start_recording(body: StartRecordingRequest) -> Response | RecordingResult:
        try:
            return RecordingResult.model_validate(recording_api.start(body.source, body.title))
        except RecordingError as exc:
            return recording_error(exc)

    @app.post(
        "/api/recordings/{recording_id}/stop",
        response_model=RecordingResult,
        responses=error_responses(400, 401, 409, 503),
        dependencies=authenticated,
        operation_id="stopRecording",
        summary="Stop and finalize a recording",
    )
    def stop_recording(recording_id: RecordingId) -> Response | RecordingResult:
        try:
            return RecordingResult.model_validate(recording_api.stop(recording_id))
        except RecordingError as exc:
            return recording_error(exc)

    @app.post(
        "/api/recordings/{recording_id}/download-ticket",
        response_model=DownloadTicket,
        responses=error_responses(400, 401, 404, 503),
        status_code=201,
        dependencies=authenticated,
        operation_id="createRecordingDownloadTicket",
        summary="Create a one-use download ticket",
    )
    def create_download_ticket(recording_id: RecordingId) -> Response | DownloadTicket:
        try:
            return DownloadTicket.model_validate(recording_api.issue_download(recording_id))
        except RecordingError as exc:
            return recording_error(exc)

    @app.get(
        "/api/recordings/{recording_id}/file",
        response_class=StreamingResponse,
        responses={
            200: {"content": {"audio/wav": {}}},
            400: {"model": ErrorResponse},
            401: {"model": ErrorResponse},
            404: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
        operation_id="downloadRecording",
        summary="Download a recording with a one-use ticket",
    )
    def download_recording(recording_id: RecordingId, ticket: str = Query(min_length=1)) -> Response:
        try:
            opened = recording_api.open_download(recording_id, ticket)
        except RecordingError as exc:
            return recording_error(exc)

        def file_body() -> Iterator[bytes]:
            with opened.source:
                while chunk := opened.source.read(64 * 1024):
                    yield chunk

        return StreamingResponse(
            file_body(),
            media_type="audio/wav",
            headers={
                "Content-Length": str(opened.size),
                "Content-Disposition": f'attachment; filename="{opened.name}"',
                "Cache-Control": "private, no-store",
            },
        )

    @app.delete(
        "/api/recordings/{recording_id}",
        response_model=DeleteRecordingResult,
        responses=error_responses(400, 401, 404, 409, 503),
        dependencies=authenticated,
        operation_id="deleteRecording",
        summary="Delete a saved recording",
    )
    def delete_recording(recording_id: RecordingId) -> Response | DeleteRecordingResult:
        try:
            return DeleteRecordingResult.model_validate(recording_api.delete(recording_id))
        except RecordingError as exc:
            return recording_error(exc)

    def console_response(request: Request) -> HTMLResponse:
        raw_base = request.headers.get("X-Ingress-Path", "")
        ingress_base = raw_base if INGRESS_BASE_PATTERN.fullmatch(raw_base) else ""
        nonce = secrets.token_urlsafe(18)
        body = CONSOLE_PAGE.replace(b"__INGRESS_BASE__", ingress_base.encode())
        body = body.replace(b"<script", f'<script nonce="{nonce}"'.encode())
        body = body.replace(b"<style", f'<style nonce="{nonce}"'.encode())
        return HTMLResponse(
            body,
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                "Content-Security-Policy": (
                    f"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'nonce-{nonce}'; "
                    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'self'"
                ),
            },
        )

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def root_console(request: Request) -> HTMLResponse:
        return console_response(request)

    @app.get("/recordings", response_class=HTMLResponse, include_in_schema=False)
    @app.get("/recordings/", response_class=HTMLResponse, include_in_schema=False)
    def recordings_console(request: Request) -> HTMLResponse:
        return console_response(request)

    return app
