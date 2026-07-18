from __future__ import annotations

import time
import wave
from pathlib import Path
from typing import cast

from recording_fixtures import RecordingServiceHarness, payload

from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.recording import SILENCE_BATCH_PACKETS


class RecordingTimelineTests(RecordingServiceHarness):
    """Timeline policy: gaps, duplicates, ordering, and empty sessions."""

    def test_sequence_gaps_become_silence_and_duplicates_do_not_repeat_audio(self) -> None:
        started = self.service.start("192.0.2.10", "Rare album")
        self.source.hub.ingest(10, payload(100))
        self.source.hub.ingest(12, payload(200))
        self.source.hub.ingest(12, payload(200))

        stopped = self.service.stop(started["id"])

        self.assertEqual(stopped["state"], "complete")
        self.assertEqual(stopped["frames"], DEFAULT_FORMAT.frames_per_packet * 3)
        self.assertEqual(stopped["gap_packets"], 1)
        self.assertEqual(stopped["duplicate_packets"], 1)
        opened = self.store.open_file(started["id"])
        with opened.source, wave.open(opened.source, "rb") as recording:
            self.assertEqual(recording.getframerate(), DEFAULT_FORMAT.rate)
            self.assertEqual(recording.getnchannels(), DEFAULT_FORMAT.channels)
            self.assertEqual(recording.getsampwidth(), DEFAULT_FORMAT.bits // 8)
            self.assertEqual(recording.readframes(DEFAULT_FORMAT.frames_per_packet), payload(100))
            self.assertEqual(
                recording.readframes(DEFAULT_FORMAT.frames_per_packet), bytes(DEFAULT_FORMAT.payload_bytes)
            )
            self.assertEqual(recording.readframes(DEFAULT_FORMAT.frames_per_packet), payload(200))

    def test_backwards_timeline_keeps_an_interrupted_partial_recording(self) -> None:
        started = self.service.start("192.0.2.10", "Restarted source")
        self.source.hub.ingest(10, payload(100))
        self.source.hub.ingest(9, payload(200))

        saved = self.wait_for_saved()

        self.assertEqual(saved["state"], "interrupted")
        self.assertIn("timeline moved backwards", str(saved["error"]))
        self.store.ensure_file(started["id"])
        deadline = time.monotonic() + 1
        while True:
            lifecycle = cast("dict[str, object]", self.sources.snapshot()["192.0.2.10"]["lifecycle"])
            if lifecycle["recording_sessions"] == 0 or time.monotonic() >= deadline:
                break
            time.sleep(0.01)
        self.assertEqual(lifecycle["recording_sessions"], 0)

    def test_gap_larger_than_one_write_batch_preserves_the_full_timeline(self) -> None:
        started = self.service.start("192.0.2.10", "Long gap")
        self.source.hub.ingest(10, payload(100))
        second_sequence = 10 + SILENCE_BATCH_PACKETS + 2
        self.source.hub.ingest(second_sequence, payload(200))

        stopped = self.service.stop(started["id"])

        expected_gap = SILENCE_BATCH_PACKETS + 1
        self.assertEqual(stopped["gap_packets"], expected_gap)
        self.assertEqual(stopped["frames"], (expected_gap + 2) * DEFAULT_FORMAT.frames_per_packet)
        opened = self.store.open_file(started["id"])
        with opened.source, wave.open(opened.source, "rb") as recording:
            self.assertEqual(recording.getnframes(), stopped["frames"])

    def test_stop_before_audio_discards_the_empty_part(self) -> None:
        started = self.service.start("192.0.2.10", "Nothing played")

        stopped = self.service.stop(started["id"])

        self.assertEqual(stopped["state"], "empty")
        self.assertEqual(self.service.list()["saved"], [])
        self.assertEqual(list(Path(self.temp.name).iterdir()), [])
