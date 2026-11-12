from __future__ import annotations

import unittest

from streamline_bridge.pipeline import AudioPipeline

AUDIO = b"\x01\x00\x02\x00" * 256


class AudioPipelineSignalTests(unittest.TestCase):
    def test_signal_follows_the_latest_packet_and_resets_with_the_session(self) -> None:
        pipeline = AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)
        self.assertIsNone(pipeline.snapshot()["signal"])

        pipeline.ingest(1, AUDIO)
        self.assertEqual(pipeline.snapshot()["signal"], "present")
        pipeline.ingest(2, b"")
        self.assertEqual(pipeline.snapshot()["signal"], "absent")

        pipeline.reset_source_session()
        self.assertIsNone(pipeline.snapshot()["signal"])


if __name__ == "__main__":
    unittest.main()
