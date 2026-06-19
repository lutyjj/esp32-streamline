from __future__ import annotations

import unittest

from streamline_bridge.protocol import DEFAULT_FORMAT, HEADER, MAGIC, VERSION, parse_header, parse_packet


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
