"""Bridge process wiring."""

from __future__ import annotations

import logging
import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import uvicorn

from streamline_bridge.http import make_app
from streamline_bridge.http_ingress import ProgressDeadlineH11Protocol
from streamline_bridge.options import parse_args, validate_args
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.recording import RecordingService, RecordingStore
from streamline_bridge.sources import SourceRegistry
from streamline_bridge.tcp import TcpIngestServer
from streamline_bridge.transport import TlsPskAuthenticator, TransportControl, TransportStateStore

logger = logging.getLogger(__name__)
HTTP_GRACEFUL_SHUTDOWN_SECONDS = 5


def bridge_version() -> str:
    try:
        return version("streamline-bridge")
    except PackageNotFoundError:
        return "dev"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = validate_args(parse_args())

    def make_pipeline() -> AudioPipeline:
        return AudioPipeline(
            max_client_chunks=args.client_buffer_chunks,
            playout_buffer_seconds=args.playout_buffer_seconds,
            max_repeat_conceal_packets=args.max_repeat_conceal_packets,
            max_outage_silence_seconds=args.max_outage_silence_seconds,
        )

    sources = SourceRegistry(
        make_pipeline,
        max_sources=args.max_sources,
        allowed=args.source_allow,
        eviction_idle_seconds=args.source_eviction_idle_seconds,
    )
    api_token = os.environ.get("STREAMLINE_API_TOKEN", "") or None
    if api_token is not None and len(api_token) < 16:
        raise SystemExit("STREAMLINE_API_TOKEN must contain at least 16 characters")
    recordings: RecordingService | None = None
    if args.recordings_dir:
        if api_token is None:
            raise SystemExit("STREAMLINE_API_TOKEN is required when recording is enabled")
        recordings = RecordingService(sources, RecordingStore(Path(args.recordings_dir)))
    state_store: TransportStateStore | None = None
    tls_authenticator: TlsPskAuthenticator | None = None
    if args.transport_state_file:
        state_store = TransportStateStore(Path(args.transport_state_file), maximum=min(args.max_sources * 2, 64))
        tls_authenticator = TlsPskAuthenticator(state_store)
    transport = TransportControl(state_store, tls_authenticator, port=args.tcp_port)
    pcm_server = TcpIngestServer(
        sources,
        args.tcp_bind,
        args.tcp_port,
        args.source_idle_timeout_seconds,
        max_connections=args.max_sources * 2,
        authenticators=transport,
    )
    transport.bind_producer_disconnect(pcm_server.close_producers)
    server = uvicorn.Server(
        uvicorn.Config(
            make_app(
                sources,
                bridge_version(),
                recordings,
                api_token,
                transport,
                healthy=lambda: pcm_server.healthy,
                progress_deadline_seconds=args.http_request_timeout_seconds,
            ),
            host=args.http_bind,
            port=args.http_port,
            log_config=None,
            # Uvicorn counts the current connection before applying its >= limit.
            limit_concurrency=args.max_http_connections + 1,
            # One knob, applied as a progress deadline at every phase: header
            # reads and body reads through the protocol, response writes
            # through the ingress guard, and keep-alive idling by uvicorn.
            timeout_keep_alive=args.http_request_timeout_seconds,
            timeout_graceful_shutdown=HTTP_GRACEFUL_SHUTDOWN_SECONDS,
            http=ProgressDeadlineH11Protocol,
        )
    )
    result = 0
    try:
        pcm_server.start(on_failure=lambda _exc: setattr(server, "should_exit", True))
        logger.info("serving HTTP WAV on http://%s:%s/streamline.wav", args.http_bind, args.http_port)
        server.run()
        if pcm_server.failure is not None:
            result = 1
    except OSError as exc:
        logger.error("cannot start PCM listener on %s:%s: %s", args.tcp_bind, args.tcp_port, exc)
        result = 1
    except KeyboardInterrupt:
        logger.info("stopped")
    finally:
        pcm_server.close()
        if recordings is not None:
            recordings.shutdown()
        sources.close()
    return result


if __name__ == "__main__":
    raise SystemExit(main())
