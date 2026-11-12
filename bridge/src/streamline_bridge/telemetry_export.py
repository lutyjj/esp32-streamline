"""Native OTLP HTTP exporter with session-owned TLS trust and no redirects."""

from __future__ import annotations

import os
import tempfile
import time
from contextlib import ExitStack
from typing import TYPE_CHECKING

import requests
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

if TYPE_CHECKING:
    from requests import Response

    from streamline_bridge.telemetry_models import SessionRequest

MAX_RESPONSE_BYTES = 4096
RESPONSE_SECONDS = 0.5


def _bounded_response(response: Response, **_kwargs: object) -> Response:
    """Validate before Requests buffers content or prepares a redirect."""
    started = time.monotonic()
    with response:
        if response.status_code < 200 or 300 <= response.status_code < 400:
            raise requests.HTTPError("OTLP endpoint did not accept the request", response=response)
        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise requests.RequestException("compressed OTLP responses are unsupported")
        body = bytearray()
        while True:
            if time.monotonic() - started > RESPONSE_SECONDS:
                raise requests.Timeout("OTLP response deadline exceeded")
            chunk = response.raw.read1(MAX_RESPONSE_BYTES + 1 - len(body), decode_content=False)
            if not chunk:
                break
            body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                raise requests.RequestException("OTLP response exceeds 4096 bytes")
        # Requests' eager buffering has no limit. Cache the bounded body in
        # its response object for the native exporter's content/text access.
        response._content = bytes(body)
        response._content_consumed = True
        return response


class ExportSession(requests.Session):
    """Keep the private CA alive exactly as long as the native HTTP session."""

    def __init__(self, ca_pem: str) -> None:
        super().__init__()
        self.trust_env = False
        self.headers["Accept-Encoding"] = "identity"
        self.hooks["response"].append(_bounded_response)
        self._files = ExitStack()
        self._ca = (
            self._files.enter_context(tempfile.NamedTemporaryFile(mode="w+", encoding="utf-8")) if ca_pem else None  # noqa: SIM115 -- session owns the ExitStack
        )
        if self._ca is not None:
            self._ca.write(ca_pem)
            self._ca.flush()
            self.verify = self._ca.name

    def close(self) -> None:
        super().close()
        self._files.close()


def make_exporter(config: SessionRequest) -> OTLPSpanExporter:
    if any(key.startswith("OTEL_EXPORTER_OTLP") for key in os.environ):
        raise ValueError("Configure export through the API; remove OTEL_EXPORTER_OTLP environment settings")
    session = ExportSession(config.ca_certificate_pem)
    try:
        return OTLPSpanExporter(
            endpoint=config.endpoint,
            headers={"Authorization": f"Bearer {config.bearer_token}"} if config.bearer_token else {},
            timeout=0.5,
            max_request_size=32_768,
            session=session,
            certificate_file=session.verify if isinstance(session.verify, str) else None,
        )
    except Exception:
        session.close()
        raise
