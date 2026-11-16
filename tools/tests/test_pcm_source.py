from __future__ import annotations

import json
import unittest
from pathlib import Path

from streamline_tools.pcm_source import Frames

VECTORS = json.loads(Path("/repo/docs/pcm-frame-vectors.json").read_text(encoding="utf-8"))


class FramesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.frames = Frames(VECTORS)
        self.valid = {vector["name"]: bytes.fromhex(vector["frame_hex"]) for vector in VECTORS["valid"]}

    def test_renumbered_frames_are_the_firmware_encoder_s_frames(self) -> None:
        self.assertEqual(self.frames.frame(0), self.valid["sequence_zero"])
        self.assertEqual(self.frames.frame(1), self.valid["full_frame"])
        self.assertEqual(self.frames.frame(0xFFFFFFFF), self.valid["sequence_wrap_max"])

    def test_a_stream_numbers_its_packets_in_order_and_wraps(self) -> None:
        stream = self.frames.stream(0xFFFFFFFF)

        self.assertEqual([next(stream) for _ in range(2)], [self.frames.frame(0xFFFFFFFF), self.frames.frame(0)])

    def test_packets_follow_the_sample_rate(self) -> None:
        constants = VECTORS["constants"]

        self.assertAlmostEqual(self.frames.seconds, constants["frames_per_packet"] / constants["sample_rate"])
