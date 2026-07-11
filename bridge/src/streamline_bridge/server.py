"""Bridge process wiring."""

from __future__ import annotations

import logging
import threading
from http.server import ThreadingHTTPServer
from importlib.metadata import PackageNotFoundError, version

from streamline_bridge.http import make_handler
from streamline_bridge.options import parse_args, validate_args
from streamline_bridge.pipeline import AudioPipeline
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
    tcp_server = TcpIngestServer(sources, args.tcp_bind, args.tcp_port, args.source_idle_timeout_seconds)
    threading.Thread(target=tcp_server.serve_forever, daemon=True).start()
    server = ThreadingHTTPServer((args.http_bind, args.http_port), make_handler(sources, bridge_version()))
    logger.info("serving HTTP WAV on http://%s:%s/streamline.wav", args.http_bind, args.http_port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("stopped")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
