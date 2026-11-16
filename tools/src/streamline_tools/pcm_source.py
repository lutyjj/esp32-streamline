"""Stream PCM to a bridge in real time from the firmware's conformance frames.

The frames come from `docs/pcm-frame-vectors.json`, which the firmware's own
encoder writes, so this source sends what a device sends without a third
implementation of the frame. Stdlib-only, so any `python3` runs it, the
bridge image's included.
"""

from __future__ import annotations

import argparse
import json
import socket
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

# How long a dropped or refused connection waits before the next attempt.
RETRY_SECONDS = 1.0


class Frames:
    """The full conformance frame, renumbered for each packet of a stream."""

    def __init__(self, vectors: dict[str, Any]) -> None:
        valid = {vector["name"]: vector for vector in vectors["valid"]}
        zero = bytes.fromhex(valid["sequence_zero"]["frame_hex"])
        marked = bytes.fromhex(valid["sequence_little_endian"]["frame_hex"])
        # The two vectors differ only in the sequence, which locates it in the header.
        changed = [index for index, (a, b) in enumerate(zip(zero, marked, strict=True)) if a != b]
        self.offset = changed[0]
        width = changed[-1] - self.offset + 1
        if (
            int.from_bytes(marked[self.offset : self.offset + width], "little")
            != valid["sequence_little_endian"]["sequence"]
        ):
            raise ValueError("the vectors do not carry a little-endian sequence")
        self.width = width
        self.template = bytes.fromhex(valid["full_frame"]["frame_hex"])
        constants = vectors["constants"]
        self.seconds = constants["frames_per_packet"] / constants["sample_rate"]

    def frame(self, sequence: int) -> bytes:
        packet = bytearray(self.template)
        packet[self.offset : self.offset + self.width] = (sequence % 2 ** (8 * self.width)).to_bytes(
            self.width, "little"
        )
        return bytes(packet)

    def stream(self, first: int = 0) -> Iterator[bytes]:
        sequence = first
        while True:
            yield self.frame(sequence)
            sequence += 1


def send(frames: Frames, host: str, port: int) -> None:
    """Send frames at the sample rate, reconnecting until stopped; the sequence runs on across connections."""
    packets = frames.stream()
    pending = next(packets)
    while True:
        try:
            with socket.create_connection((host, port), timeout=5) as connection:
                due = time.monotonic()
                while True:
                    connection.sendall(pending)
                    pending = next(packets)
                    due += frames.seconds
                    time.sleep(max(0.0, due - time.monotonic()))
        except OSError:
            time.sleep(RETRY_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stream PCM to a bridge in real time.")
    parser.add_argument("vectors", type=Path, help="docs/pcm-frame-vectors.json")
    parser.add_argument("host", help="the bridge's PCM listener host")
    parser.add_argument("port", type=int, nargs="?", default=39000)
    arguments = parser.parse_args()
    frames = Frames(json.loads(arguments.vectors.read_text(encoding="utf-8")))
    send(frames, arguments.host, arguments.port)


if __name__ == "__main__":
    main()
