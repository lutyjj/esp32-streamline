from __future__ import annotations

import json
import unittest
from pathlib import Path

from streamline_bridge.protocol import (
    DEFAULT_BITS,
    DEFAULT_CHANNELS,
    DEFAULT_FORMAT,
    DEFAULT_FRAMES,
    DEFAULT_RATE,
    HEADER,
    MAGIC,
    VERSION,
    parse_header,
    parse_packet,
)


def make_header(**overrides: int | bytes) -> bytes:
    values: dict[str, int | bytes] = {
        "magic": MAGIC,
        "version": VERSION,
        "header_size": HEADER.size,
        "channels": DEFAULT_FORMAT.channels,
        "bits": DEFAULT_FORMAT.bits,
        "sequence": 42,
        "rate": DEFAULT_FORMAT.rate,
        "frames": DEFAULT_FORMAT.frames_per_packet,
        "payload_bytes": DEFAULT_FORMAT.payload_bytes,
    }
    values.update(overrides)
    return HEADER.pack(
        values["magic"],
        values["version"],
        values["header_size"],
        values["channels"],
        values["bits"],
        values["sequence"],
        values["rate"],
        values["frames"],
        values["payload_bytes"],
    )


class ProtocolTests(unittest.TestCase):
    def test_accepts_the_declared_stream_format(self) -> None:
        header = make_header()
        payload = bytes(DEFAULT_FORMAT.payload_bytes)

        self.assertEqual(parse_header(header), (42, 48_000, 256, 1024))
        self.assertEqual(parse_packet(header + payload), (42, 48_000, 256, payload))

    def test_rejects_any_format_that_the_wav_bridge_cannot_serve(self) -> None:
        for invalid_header in (
            make_header(rate=44_100),
            make_header(channels=1),
            make_header(bits=24),
            make_header(frames=512, payload_bytes=2048),
            make_header(payload_bytes=1),
        ):
            with self.subTest(header=invalid_header), self.assertRaises(ValueError):
                parse_header(invalid_header)

    def test_rejects_truncated_or_length_mismatched_packets(self) -> None:
        header = make_header()
        with self.assertRaises(ValueError):
            parse_header(header[:-1])
        with self.assertRaises(ValueError):
            parse_packet(header + bytes(DEFAULT_FORMAT.payload_bytes - 1))


class ConformanceVectorTests(unittest.TestCase):
    """Prove the parser agrees with the firmware encoder on the shared corpus.

    ``docs/pcm-frame-vectors.json`` is generated from the Rust encoder by
    ``make firmware-pcm-frame-vectors``; this test keeps the parser byte-exact
    with it.
    """

    vectors = json.loads(Path("/repo/docs/pcm-frame-vectors.json").read_text(encoding="utf-8"))

    def test_constants_match_the_parser(self) -> None:
        constants = self.vectors["constants"]
        self.assertEqual(constants["magic"], MAGIC.decode("ascii"))
        self.assertEqual(constants["version"], VERSION)
        self.assertEqual(constants["header_len"], HEADER.size)
        self.assertEqual(constants["sample_rate"], DEFAULT_RATE)
        self.assertEqual(constants["channels"], DEFAULT_CHANNELS)
        self.assertEqual(constants["bits_per_sample"], DEFAULT_BITS)
        self.assertEqual(constants["bytes_per_frame"], DEFAULT_CHANNELS * (DEFAULT_BITS // 8))
        self.assertEqual(constants["frames_per_packet"], DEFAULT_FRAMES)
        self.assertEqual(constants["payload_bytes"], DEFAULT_FORMAT.payload_bytes)

    def test_encoder_frames_parse_with_the_deployed_format(self) -> None:
        for vector in self.vectors["valid"]:
            with self.subTest(vector=vector["name"]):
                frame = bytes.fromhex(vector["frame_hex"])
                seq, rate, frames, payload = parse_packet(frame)
                self.assertEqual(seq, vector["sequence"])
                self.assertEqual(rate, DEFAULT_RATE)
                self.assertEqual(frames, vector["frames"])
                self.assertEqual(len(payload), vector["payload_bytes"])
                self.assertEqual(payload, frame[HEADER.size :])

    def test_malformed_frames_are_rejected(self) -> None:
        for vector in self.vectors["invalid"]:
            with self.subTest(vector=vector["name"]), self.assertRaises(ValueError):
                parse_packet(bytes.fromhex(vector["frame_hex"]))
