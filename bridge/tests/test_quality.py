from __future__ import annotations

import unittest

from streamline_bridge.quality import QualityWindow


class QualityWindowTests(unittest.TestCase):
    def test_window_ages_without_polling_and_includes_only_current_sixty_buckets(self) -> None:
        window = QualityWindow()
        self.assertEqual(window.snapshot(100.0)["observed_seconds"], 0)
        window.record("missing_packets", 100.0)
        window.record("audio_packets", 101.0)
        window.record("silence_packets", 159.0)
        snapshot = window.snapshot(160.0)
        self.assertEqual(snapshot["observed_seconds"], 60)
        self.assertEqual(snapshot["missing_packets"], 0)
        self.assertEqual(snapshot["audio_packets"], 1)
        self.assertEqual(snapshot["silence_packets"], 1)
        self.assertEqual(window.snapshot(220.0)["silence_packets"], 0)

    def test_warmup_and_interruptions_remain_visible_between_status_polls(self) -> None:
        window = QualityWindow()
        window.record("audio_packets", 50.0)
        window.record("disconnects", 51.0)
        window.record("underruns", 52.0)
        window.record("audio_packets", 53.0)
        snapshot = window.snapshot(55.5)
        self.assertEqual(snapshot["observed_seconds"], 5.5)
        self.assertEqual(snapshot["audio_packets"], 2)
        self.assertEqual(snapshot["disconnects"], 1)
        self.assertEqual(snapshot["underruns"], 1)
