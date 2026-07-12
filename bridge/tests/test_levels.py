from __future__ import annotations

import struct
import unittest

from streamline_bridge.levels import AudioLevels, LevelSnapshot, analyze_pcm16_stereo
from streamline_bridge.pipeline import AudioPipeline


def frames(*samples: tuple[int, int]) -> bytes:
    return b"".join(struct.pack("<hh", *sample) for sample in samples)


class AudioLevelTests(unittest.TestCase):
    def test_measures_peak_and_rms_per_channel(self) -> None:
        measured = analyze_pcm16_stereo(frames((100, -200), (-50, 32_767), (0, 32_000)))

        self.assertEqual(measured.peak_left, 100)
        self.assertEqual(measured.peak_right, 32_767)
        self.assertEqual(measured.rms_left, 64)
        self.assertEqual(measured.rms_right, 26_443)

    def test_handles_silence_full_scale_negative_and_partial_frames(self) -> None:
        self.assertEqual(analyze_pcm16_stereo(bytes(8)), LevelSnapshot())
        self.assertEqual(analyze_pcm16_stereo(frames((-32_768, -32_768))).peak_left, 32_768)
        self.assertEqual(analyze_pcm16_stereo(b"\x01\x02\x03"), LevelSnapshot())

    def test_tracker_replaces_the_previous_packet_snapshot(self) -> None:
        levels = AudioLevels()
        levels.update(frames((12_000, 6_000)))
        levels.update(bytes(4))

        self.assertEqual(
            levels.snapshot(),
            {"peak_left": 0, "peak_right": 0, "rms_left": 0, "rms_right": 0},
        )

    def test_new_source_session_clears_stale_levels(self) -> None:
        pipeline = AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)
        pipeline.ingest(1, frames((12_000, 6_000)))

        pipeline.reset_source_session()

        self.assertEqual(
            pipeline.snapshot()["levels"],
            {"peak_left": 0, "peak_right": 0, "rms_left": 0, "rms_right": 0},
        )
