"""Bridge process wiring."""

from __future__ import annotations

import logging
import os
import threading
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

from streamline_bridge.http import BoundedThreadingHTTPServer, make_handler
from streamline_bridge.options import parse_args, validate_args
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.recording import RecordingService, RecordingStore
from streamline_bridge.sources import SourceRegistry
from streamline_bridge.tcp import TcpIngestServer

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
    tcp_server = TcpIngestServer(
        sources,
        args.tcp_bind,
        args.tcp_port,
        args.source_idle_timeout_seconds,
        max_connections=args.max_sources * 2,
    )
    threading.Thread(target=tcp_server.serve_forever, daemon=True).start()
    server = BoundedThreadingHTTPServer(
        (args.http_bind, args.http_port),
        make_handler(sources, bridge_version(), recordings, recording_token),
        max_connections=args.max_http_connections,
        request_timeout_seconds=args.http_request_timeout_seconds,
    )
    logger.info("serving HTTP WAV on http://%s:%s/streamline.wav", args.http_bind, args.http_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("stopped")
    finally:
        server.server_close()
        if recordings is not None:
            recordings.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
