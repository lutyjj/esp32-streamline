"""Bound HTTP ingress I/O: one body-size ceiling and progress deadlines."""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import h11
from fastapi import HTTPException
from uvicorn.protocols.http.h11_impl import H11Protocol

from streamline_bridge.api_models import ErrorDetail, ErrorResponse

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, MutableMapping

    Message = MutableMapping[str, object]
    Scope = MutableMapping[str, object]
    Receive = Callable[[], Awaitable[Message]]
    Send = Callable[[Message], Awaitable[None]]
    AsgiApp = Callable[[Scope, Receive, Send], Awaitable[None]]

logger = logging.getLogger(__name__)


class HttpIngressGuard:
    """Pure ASGI middleware that bounds request bodies and response writes.

    Every received chunk is counted, so chunked bodies, absent lengths, and
    falsely declared lengths meet the same 413 as declared oversize ones
    before an oversize payload can reach a parser: the ceiling crossing
    raises an ``HTTPException`` that FastAPI re-raises untouched for the
    app's error handler. Each response write gets a progress deadline, so a
    client that stops reading a stream cannot hold its connection slot;
    stalled request reads are closed underneath by
    :class:`ProgressDeadlineH11Protocol`.
    """

    def __init__(self, app: AsgiApp, max_body_bytes: int, progress_deadline_seconds: float) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.progress_deadline_seconds = progress_deadline_seconds
        self._message = f"Request bodies must not exceed {max_body_bytes} bytes."
        self._too_large_body = (
            ErrorResponse(error=ErrorDetail(code="request-too-large", message=self._message)).model_dump_json().encode()
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        if not self._declared_length_acceptable(scope):
            await self._send_too_large(send)
            return

        received = 0

        async def counted_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                body = message.get("body", b"")
                assert isinstance(body, bytes)
                received += len(body)
                if received > self.max_body_bytes:
                    # FastAPI re-raises an HTTPException from body reading
                    # untouched, so the app's error handler owns the 413.
                    raise HTTPException(
                        status_code=413,
                        detail={"code": "request-too-large", "message": self._message},
                        headers={"Connection": "close"},
                    )
            return message

        async def deadlined_send(message: Message) -> None:
            try:
                await asyncio.wait_for(send(message), self.progress_deadline_seconds)
            except TimeoutError:
                logger.warning(
                    "dropping HTTP client %s: no write progress within %.3gs",
                    _client_address(scope),
                    self.progress_deadline_seconds,
                )
                raise

        await self.app(scope, counted_receive, deadlined_send)

    def _declared_length_acceptable(self, scope: Scope) -> bool:
        headers = scope.get("headers")
        assert isinstance(headers, list)
        for name, value in headers:
            if name != b"content-length":
                continue
            try:
                return int(value) <= self.max_body_bytes
            except ValueError:
                return False
        return True

    async def _send_too_large(self, send: Send) -> None:
        # ``Connection: close`` keeps a reused connection honest: the unread
        # request body must never be parsed as the next request.
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(self._too_large_body)).encode()),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": self._too_large_body})


class ProgressDeadlineH11Protocol(H11Protocol):
    """H11 protocol whose read deadline also runs while a request arrives.

    Uvicorn cancels its keep-alive timer on any received byte and re-arms it
    only after a response completes, so a client stalling mid-header or
    mid-body would hold a connection slot forever. While h11 still awaits
    request bytes, this subclass re-arms that timer slot with a hard
    transport close — uvicorn's own handler performs an h11 close handshake
    that is illegal mid-request — so ``timeout_keep_alive`` without progress
    always ends the connection. Coupled to the pinned uvicorn's
    ``H11Protocol`` internals: ``conn``, ``timeout_keep_alive_task``, and
    ``loop``.
    """

    def data_received(self, data: bytes) -> None:
        super().data_received(data)
        request_incomplete = self.conn.their_state in {h11.IDLE, h11.SEND_BODY}
        if request_incomplete and self.timeout_keep_alive_task is None and not self.transport.is_closing():
            self.timeout_keep_alive_task = self.loop.call_later(self.timeout_keep_alive, self._close_stalled_request)

    def _close_stalled_request(self) -> None:
        if not self.transport.is_closing():
            self.transport.close()


def _client_address(scope: Scope) -> str:
    client = scope.get("client")
    if isinstance(client, (tuple, list)) and len(client) == 2:
        return f"{client[0]}:{client[1]}"
    return "unknown"
