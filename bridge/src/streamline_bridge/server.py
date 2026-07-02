#!/usr/bin/env python3
"""Bridge ESP32 StreamLine TCP PCM packets to a live HTTP WAV stream."""

from __future__ import annotations

import argparse
import contextlib
import ipaddress
import json
import os
import queue
import socket
import struct
import threading
import time
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import PackageNotFoundError, version
from typing import NoReturn
from urllib.parse import parse_qs, urlsplit

from streamline_bridge.protocol import DEFAULT_FORMAT, DEFAULT_RATE, HEADER, PcmFormat, parse_header
from streamline_bridge.sources import Source, SourceRegistry, SourceSelectionError


def bridge_version() -> str:
    """Return installed package metadata, or a clear source-tree development value."""
    try:
        return version("streamline-bridge")
    except PackageNotFoundError:
        return "dev"


BRIDGE_VERSION = bridge_version()
MAX_UINT32 = 0xFFFFFFFF
UINT32_MOD = 0x100000000
DEFAULT_PLAYOUT_BUFFER_SECONDS = 1.0
DEFAULT_MAX_REPEAT_CONCEAL_PACKETS = 3
DEFAULT_MAX_OUTAGE_SILENCE_SECONDS = 5.0
DEFAULT_CLIENT_BUFFER_CHUNKS = 2048
DEFAULT_SOURCE_IDLE_TIMEOUT_SECONDS = 5.0
DEFAULT_MAX_SOURCES = 8
HTTP_MAX_BATCH_CHUNKS = 64


@dataclass
class ReceiverStats:
    packets: int = 0
    lost: int = 0
    concealed: int = 0
    late: int = 0
    reordered: int = 0
    duplicate: int = 0
    underruns: int = 0
    client_queue_drops: int = 0
    slow_clients: int = 0
    buffered_packets: int = 0
    client_buffer_chunks: int = 0
    playout_buffer_packets: int = 0
    max_outage_silence_packets: int = 0
    bytes: int = 0
    frames: int = 0
    played_frames: int = 0
    clients: int = 0
    rate: int = DEFAULT_RATE
    packet_frames: int | None = None
    playout_seq: int | None = None
    last_seq: int | None = None
    highest_seq: int | None = None
    last_packet_at: float | None = None
    last_playout_at: float | None = None
    buffer_ready_at: float | None = None
    started_at: float = 0.0
    tcp_connections: int = 0
    tcp_disconnects: int = 0
    tcp_errors: int = 0


@dataclass
class ClientStats:
    id: int
    remote_addr: str
    path: str
    connected_at: float
    bytes_sent: int = 0
    chunks_sent: int = 0
    batches_sent: int = 0
    queue_drops: int = 0
    queue_depth: int = 0
    last_write_at: float | None = None


@dataclass
class ClientStream:
    stats: ClientStats
    queue: queue.Queue[bytes | None]
    client_socket: socket.socket


class AudioHub:
    def __init__(
        self,
        max_client_chunks: int,
        playout_buffer_seconds: float,
        max_repeat_conceal_packets: int,
        max_outage_silence_seconds: float,
        pcm_format: PcmFormat = DEFAULT_FORMAT,
    ) -> None:
        self._format = pcm_format
        self._max_client_chunks = max_client_chunks
        self._playout_buffer_seconds = playout_buffer_seconds
        self._max_repeat_conceal_packets = max_repeat_conceal_packets
        self._max_outage_silence_seconds = max_outage_silence_seconds
        self._lock = threading.Lock()
        self._buffer_ready = threading.Event()
        self._packets: dict[int, bytes] = {}
        self._clients: dict[int, ClientStream] = {}
        self._next_client_id = 1
        self._packet_interval = self._format.frames_per_packet / self._format.rate
        self._playout_buffer_packets = max(1, round(playout_buffer_seconds / self._packet_interval))
        self._last_payload: bytes | None = None
        self._last_payload_size = self._format.payload_bytes
        self._loss_run = 0
        self._outage_conceal_packets = 0
        self.stats = ReceiverStats(started_at=time.time())
        self.stats.client_buffer_chunks = self._max_client_chunks
        self.stats.playout_buffer_packets = self._playout_buffer_packets
        self.stats.max_outage_silence_packets = self._max_outage_silence_packets()

    def register(self, remote_addr: str, path: str, client_socket: socket.socket) -> ClientStream:
        with self._lock:
            client_id = self._next_client_id
            self._next_client_id += 1
            stream = ClientStream(
                stats=ClientStats(
                    id=client_id,
                    remote_addr=remote_addr,
                    path=path,
                    connected_at=time.time(),
                ),
                queue=queue.Queue(self._max_client_chunks),
                client_socket=client_socket,
            )
            self._clients[client_id] = stream
            self.stats.clients = len(self._clients)
            return stream

    def unregister(self, client_id: int) -> None:
        with self._lock:
            self._clients.pop(client_id, None)
            self.stats.clients = len(self._clients)

    def reset_source_session(self) -> None:
        """Clear playout state for a new source session (e.g. ESP reboot/reconnect).

        Called when a new TCP source connection is accepted so a restarted
        sequence (back to 0) is not classified as late against the previous
        session's playout_seq, which would drop every packet until the outage
        timer fires and then re-buffer.
        """
        with self._lock:
            self._packets.clear()
            self._buffer_ready.clear()
            self._last_payload = None
            self._loss_run = 0
            self._outage_conceal_packets = 0
            self.stats.playout_seq = None
            self.stats.highest_seq = None
            self.stats.buffer_ready_at = None
            self.stats.last_seq = 0
            self.stats.buffered_packets = 0

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            data = asdict(self.stats)
            data["buffered_packets"] = len(self._packets)
            data["client_streams"] = [asdict(stream.stats) for stream in self._clients.values()]
        data["uptime_seconds"] = time.time() - float(data["started_at"])
        data["bridge_version"] = BRIDGE_VERSION
        return data

    def record_client_write(self, client_id: int, byte_count: int, chunk_count: int) -> None:
        with self._lock:
            stream = self._clients.get(client_id)
            if stream is None:
                return
            stream.stats.bytes_sent += byte_count
            stream.stats.chunks_sent += chunk_count
            stream.stats.batches_sent += 1
            stream.stats.queue_depth = stream.queue.qsize()
            stream.stats.last_write_at = time.time()

    def ingest(self, seq: int, payload: bytes) -> None:
        with self._lock:
            self.stats.packets += 1
            self.stats.bytes += len(payload)
            self.stats.frames += self._format.frames_per_packet
            self.stats.rate = self._format.rate
            self.stats.packet_frames = self._format.frames_per_packet
            self.stats.last_seq = seq
            self.stats.last_packet_at = time.time()

            if self.stats.playout_seq is not None and seq_distance(self.stats.playout_seq, seq) < 0:
                self.stats.late += 1
                return

            if seq in self._packets:
                self.stats.duplicate += 1
                return

            if self.stats.highest_seq is not None and seq_distance(self.stats.highest_seq, seq) < 0:
                self.stats.reordered += 1

            self._packets[seq] = payload
            self._last_payload_size = len(payload)
            self.stats.playout_buffer_packets = self._playout_buffer_packets
            self.stats.max_outage_silence_packets = self._max_outage_silence_packets()
            self.stats.buffered_packets = len(self._packets)

            if self.stats.highest_seq is None or seq_distance(self.stats.highest_seq, seq) > 0:
                self.stats.highest_seq = seq

            if self.stats.playout_seq is None:
                self.stats.playout_seq = seq

            if len(self._packets) >= self._playout_buffer_packets:
                if self.stats.buffer_ready_at is None:
                    self.stats.buffer_ready_at = time.time()
                self._buffer_ready.set()

    def playout_loop(self) -> NoReturn:
        while True:
            self._buffer_ready.wait()

            with self._lock:
                interval = self._packet_interval

            next_tick = time.monotonic()
            while self._buffer_ready.is_set():
                chunk = self._next_playout_chunk()
                self._publish(chunk)

                next_tick += interval
                delay = next_tick - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                else:
                    next_tick = time.monotonic()

    def _next_playout_chunk(self) -> bytes:
        with self._lock:
            seq = self.stats.playout_seq
            if seq is None:
                self._buffer_ready.clear()
                return b""

            payload = self._packets.pop(seq, None)
            if payload is None:
                self.stats.lost += 1
                self.stats.concealed += 1
                self._loss_run += 1
                self._outage_conceal_packets += 1
                payload = self._conceal_payload()
            else:
                self._loss_run = 0
                self._outage_conceal_packets = 0
                self._last_payload = payload

            self.stats.playout_seq = (seq + 1) & MAX_UINT32
            self.stats.played_frames += self.stats.packet_frames or 0
            self.stats.buffered_packets = len(self._packets)
            self.stats.last_playout_at = time.time()

            if self._outage_conceal_packets > self._max_outage_silence_packets():
                self._buffer_ready.clear()
                self.stats.playout_seq = None
                self.stats.highest_seq = None
                self.stats.buffer_ready_at = None
                self._loss_run = 0
                self._outage_conceal_packets = 0
                self.stats.underruns += 1

            return payload

    def _conceal_payload(self) -> bytes:
        if self._last_payload is not None and self._loss_run <= self._max_repeat_conceal_packets:
            return attenuate_pcm16(self._last_payload, self._max_repeat_conceal_packets, self._loss_run)
        return bytes(self._last_payload_size)

    def _max_outage_silence_packets(self) -> int:
        return max(1, round(self._max_outage_silence_seconds / self._packet_interval))

    def _publish(self, payload: bytes) -> None:
        if not payload:
            return

        with self._lock:
            clients = tuple(self._clients.values())

        for stream in clients:
            try:
                stream.queue.put_nowait(payload)
                stream.stats.queue_depth = stream.queue.qsize()
            except queue.Full:
                self._evict_slow_client(stream)

    def _evict_slow_client(self, stream: ClientStream) -> None:
        with self._lock:
            if self._clients.pop(stream.stats.id, None) is None:
                return
            stream.stats.queue_drops += 1
            stream.stats.queue_depth = stream.queue.qsize()
            self.stats.client_queue_drops += 1
            self.stats.slow_clients += 1
            self.stats.clients = len(self._clients)

        with contextlib.suppress(queue.Full):
            stream.queue.put_nowait(None)
        with contextlib.suppress(OSError):
            stream.client_socket.shutdown(socket.SHUT_RDWR)
        with contextlib.suppress(OSError):
            stream.client_socket.close()
        print(
            f"evicted slow client id={stream.stats.id} "
            f"remote={stream.stats.remote_addr} queue_depth={stream.stats.queue_depth}",
            flush=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tcp-bind", default="0.0.0.0", help="TCP bind address")
    parser.add_argument("--tcp-port", type=int, default=39000, help="TCP listen port")
    parser.add_argument(
        "--source-allow",
        action="append",
        default=[os.environ.get("STREAMLINE_SOURCE_ALLOW", "")],
        metavar="IP",
        help="allow only these IPv4 source addresses; repeat or use a comma-separated list",
    )
    parser.add_argument("--http-bind", default="0.0.0.0", help="HTTP bind address")
    parser.add_argument("--http-port", type=int, default=8088, help="HTTP listen port")
    parser.add_argument(
        "--client-buffer-chunks",
        type=int,
        default=DEFAULT_CLIENT_BUFFER_CHUNKS,
        help="per-client HTTP output queue depth",
    )
    parser.add_argument(
        "--playout-buffer-seconds",
        type=float,
        default=DEFAULT_PLAYOUT_BUFFER_SECONDS,
        help="receiver jitter buffer before playout starts",
    )
    parser.add_argument(
        "--max-repeat-conceal-packets",
        type=int,
        default=DEFAULT_MAX_REPEAT_CONCEAL_PACKETS,
        help="repeat the previous packet this many times before filling loss with silence",
    )
    parser.add_argument(
        "--max-outage-silence-seconds",
        type=float,
        default=DEFAULT_MAX_OUTAGE_SILENCE_SECONDS,
        help="after this much concealed outage, pause playout and wait to re-buffer",
    )
    parser.add_argument(
        "--source-idle-timeout-seconds",
        type=float,
        default=DEFAULT_SOURCE_IDLE_TIMEOUT_SECONDS,
        help="drop an inactive TCP producer after this many seconds",
    )
    parser.add_argument(
        "--max-sources",
        type=int,
        default=DEFAULT_MAX_SOURCES,
        help="maximum number of producer pipelines to keep",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> argparse.Namespace:
    if args.client_buffer_chunks < 1:
        raise SystemExit("--client-buffer-chunks must be at least 1")
    if args.playout_buffer_seconds <= 0:
        raise SystemExit("--playout-buffer-seconds must be greater than 0")
    if args.max_repeat_conceal_packets < 0:
        raise SystemExit("--max-repeat-conceal-packets must not be negative")
    if args.max_outage_silence_seconds <= 0:
        raise SystemExit("--max-outage-silence-seconds must be greater than 0")
    if args.source_idle_timeout_seconds <= 0:
        raise SystemExit("--source-idle-timeout-seconds must be greater than 0")
    if args.max_sources < 1:
        raise SystemExit("--max-sources must be at least 1")
    try:
        args.source_allow = frozenset(
            str(ipaddress.IPv4Address(source.strip()))
            for option in args.source_allow
            for source in option.split(",")
            if source.strip()
        )
    except ipaddress.AddressValueError as exc:
        raise SystemExit(f"--source-allow must be an IPv4 address: {exc}") from exc
    if len(args.source_allow) > args.max_sources:
        raise SystemExit("--max-sources must be at least the number of allowed sources")
    return args


def seq_distance(base: int, seq: int) -> int:
    """Return signed forward distance from base to seq in uint32 sequence space."""
    distance = (seq - base) & MAX_UINT32
    if distance >= UINT32_MOD // 2:
        distance -= UINT32_MOD
    return distance


def attenuate_pcm16(payload: bytes, max_steps: int, step: int) -> bytes:
    """Return little-endian signed 16-bit PCM with linear loss-conceal attenuation."""
    gain = max(0.0, 1.0 - (step / (max_steps + 1)))
    samples = struct.iter_unpack("<h", payload)
    return b"".join(struct.pack("<h", round(sample[0] * gain)) for sample in samples)


def wav_header(pcm_format: PcmFormat = DEFAULT_FORMAT) -> bytes:
    block_align = pcm_format.channels * pcm_format.bits // 8
    byte_rate = pcm_format.rate * block_align
    unknown_size = 0xFFFFFFFF
    return b"".join(
        [
            b"RIFF",
            struct.pack("<I", unknown_size),
            b"WAVE",
            b"fmt ",
            struct.pack(
                "<IHHIIHH",
                16,
                1,
                pcm_format.channels,
                pcm_format.rate,
                byte_rate,
                block_align,
                pcm_format.bits,
            ),
            b"data",
            struct.pack("<I", unknown_size),
        ]
    )


def recv_exact(conn: socket.socket, size: int) -> bytes | None:
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = conn.recv(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def tcp_client_loop(
    source: Source[AudioHub],
    generation: int,
    conn: socket.socket,
    addr: tuple[str, int],
) -> None:
    hub = source.hub
    source_gate = source.gate
    with conn:
        with hub._lock:
            hub.stats.tcp_connections += 1
        try:
            while True:
                header = recv_exact(conn, HEADER.size)
                if header is None:
                    return

                try:
                    seq, _, _, payload_bytes = parse_header(header)
                except ValueError as exc:
                    raise ValueError(f"bad header from {addr[0]}:{addr[1]}: {exc}") from exc

                payload = recv_exact(conn, payload_bytes)
                if payload is None:
                    return
                if not source_gate.ingest(generation, seq, payload):
                    return
        except (OSError, ValueError) as exc:
            if source_gate.is_active(generation):
                with hub._lock:
                    hub.stats.tcp_errors += 1
                print(f"tcp drop from {addr[0]}:{addr[1]}: {exc}", flush=True)
        finally:
            source_gate.release(generation, conn)
            with hub._lock:
                hub.stats.tcp_disconnects += 1


def tcp_loop(
    sources: SourceRegistry[AudioHub],
    bind: str,
    port: int,
    source_idle_timeout_seconds: float,
) -> NoReturn:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((bind, port))
    sock.listen()
    print(f"listening for ESP32 TCP on {bind}:{port}", flush=True)

    while True:
        conn, addr = sock.accept()
        source = sources.acquire(addr[0])
        if source is None:
            print(f"rejected TCP source {addr[0]}:{addr[1]}", flush=True)
            conn.close()
            continue
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn.settimeout(source_idle_timeout_seconds)
        generation = source.gate.replace(conn)
        threading.Thread(
            target=tcp_client_loop,
            args=(source, generation, conn, addr),
            daemon=True,
        ).start()


def make_handler(sources: SourceRegistry[AudioHub]) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            url = urlsplit(self.path)
            if url.path == "/" or url.path == "/status":
                self._send_json({"bridge_version": BRIDGE_VERSION, "sources": sources.snapshot()})
                return
            if url.path == "/health":
                self._send_text("ok\n")
                return
            if url.path == "/streamline.wav":
                self._stream_wav(url.query)
                return
            self.send_error(HTTPStatus.NOT_FOUND, "not found")

        def log_message(self, fmt: str, *args: object) -> None:
            print(f"{self.address_string()} - {fmt % args}", flush=True)

        def _send_json(self, data: dict[str, object]) -> None:
            body = json.dumps(data, sort_keys=True).encode() + b"\n"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_text(self, body_text: str) -> None:
            body = body_text.encode()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _stream_wav(self, query: str) -> None:
            params = parse_qs(query, keep_blank_values=True)
            requested = params.get("source", [None])[0]
            try:
                source = sources.select(requested)
            except SourceSelectionError as exc:
                self.send_error(exc.status, exc.message)
                return

            stream = source.hub.register(self.client_address[0], self.path, self.connection)
            try:
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(wav_header())
                self.wfile.flush()

                while True:
                    chunks = collect_http_batch(stream.queue)
                    if chunks is None:
                        return
                    body = b"".join(chunks)
                    self.wfile.write(body)
                    self.wfile.flush()
                    source.hub.record_client_write(stream.stats.id, len(body), len(chunks))
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                source.hub.unregister(stream.stats.id)

    return Handler


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


def main() -> int:
    args = validate_args(parse_args())

    def make_hub() -> AudioHub:
        hub = AudioHub(
            max_client_chunks=args.client_buffer_chunks,
            playout_buffer_seconds=args.playout_buffer_seconds,
            max_repeat_conceal_packets=args.max_repeat_conceal_packets,
            max_outage_silence_seconds=args.max_outage_silence_seconds,
        )
        threading.Thread(target=hub.playout_loop, daemon=True).start()
        return hub

    sources = SourceRegistry(make_hub, max_sources=args.max_sources, allowed=args.source_allow)

    tcp_thread = threading.Thread(
        target=tcp_loop,
        args=(sources, args.tcp_bind, args.tcp_port, args.source_idle_timeout_seconds),
        daemon=True,
    )
    tcp_thread.start()

    server = ThreadingHTTPServer((args.http_bind, args.http_port), make_handler(sources))
    print(f"serving HTTP WAV on http://{args.http_bind}:{args.http_port}/streamline.wav", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped", flush=True)
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
