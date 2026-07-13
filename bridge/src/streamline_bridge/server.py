"""Bridge process wiring."""

from __future__ import annotations

import logging
import os
import threading
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import uvicorn

from streamline_bridge.http import make_app
from streamline_bridge.options import parse_args, validate_args
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.recording import RecordingService, RecordingStore
from streamline_bridge.sources import SourceRegistry
from streamline_bridge.tcp import TcpIngestServer
from streamline_bridge.transport import TlsPskAuthenticator, TransportControl, TransportKeyStore

logger = logging.getLogger(__name__)


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
    recordings: RecordingService | None = None
    recording_token: str | None = None
    if args.recordings_dir:
        recording_token = os.environ.get("STREAMLINE_RECORDING_TOKEN", "")
        if len(recording_token) < 16:
            raise SystemExit("STREAMLINE_RECORDING_TOKEN must contain at least 16 characters when recording is enabled")
        recordings = RecordingService(sources, RecordingStore(Path(args.recordings_dir)))
    transport_token = os.environ.get("STREAMLINE_TRANSPORT_API_TOKEN", "") or None
    key_store: TransportKeyStore | None = None
    tls_authenticator: TlsPskAuthenticator | None = None
    if args.tls_enabled:
        if transport_token is None or len(transport_token) < 16:
            raise SystemExit("STREAMLINE_TRANSPORT_API_TOKEN must contain at least 16 characters when TLS is enabled")
        key_store = TransportKeyStore(Path(args.tls_keys_file), maximum=min(args.max_sources * 2, 64))
        tls_authenticator = TlsPskAuthenticator(key_store)
    pcm_server = TcpIngestServer(
        sources,
        args.tcp_bind,
        args.tcp_port,
        args.source_idle_timeout_seconds,
        max_connections=args.max_sources * 2,
        authenticator=tls_authenticator,
    )
    threading.Thread(target=pcm_server.serve_forever, daemon=True).start()
    transport = TransportControl(
        key_store,
        tls_authenticator,
        transport_token,
        tls_enabled=args.tls_enabled,
        port=args.tcp_port,
    )
    server = uvicorn.Server(
        uvicorn.Config(
            make_app(sources, bridge_version(), recordings, recording_token, transport),
            host=args.http_bind,
            port=args.http_port,
            log_config=None,
            limit_concurrency=args.max_http_connections,
            timeout_keep_alive=args.http_request_timeout_seconds,
        )
    )
    logger.info("serving HTTP WAV on http://%s:%s/streamline.wav", args.http_bind, args.http_port)
    try:
        server.run()
    except KeyboardInterrupt:
        logger.info("stopped")
    finally:
        if recordings is not None:
            recordings.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
