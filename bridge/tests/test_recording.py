from __future__ import annotations

import json
import os
import tempfile
import time
import unittest
import wave
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.recording import (
    SILENCE_BATCH_PACKETS,
    RecordingError,
    RecordingService,
    RecordingStore,
    WavRecordingFile,
    wav_header,
)
from streamline_bridge.sources import SourceRegistry


class FixedTime:
    def __init__(self) -> None:
        self.value = datetime(2026, 7, 11, 12, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


def payload(sample: int) -> bytes:
    return sample.to_bytes(2, "little", signed=True) * (DEFAULT_FORMAT.payload_bytes // 2)


class RecordingServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = RecordingStore(Path(self.temp.name), now=FixedTime())
        self.sources = SourceRegistry(make_pipeline, max_sources=2)
        self.source = self.sources.acquire("192.0.2.10")
        self.service = RecordingService(self.sources, self.store)

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
        lifecycle = cast("dict[str, object]", self.sources.snapshot()["192.0.2.10"]["lifecycle"])
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

    def test_one_active_session_per_source_but_other_sources_remain_independent(self) -> None:
        first = self.service.start("192.0.2.10", "First")
        with self.assertRaisesRegex(Exception, "already recording"):
            self.service.start("192.0.2.10", "Duplicate")
        other = self.sources.acquire("192.0.2.11")
        second = self.service.start("192.0.2.11", "Second")
        self.source.hub.ingest(1, payload(1))
        other.hub.ingest(1, payload(2))

        self.assertEqual(self.service.stop(first["id"])["state"], "complete")
        self.assertEqual(self.service.stop(second["id"])["state"], "complete")

    def wait_for_saved(self) -> dict[str, object]:
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            saved = cast("list[dict[str, object]]", self.service.list()["saved"])
            if saved:
                return saved[0]
            time.sleep(0.01)
        self.fail("recording did not finalize")
        raise AssertionError


class RecordingRecoveryTests(unittest.TestCase):
    def test_startup_repairs_a_part_file_and_marks_it_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recording_id = "20260711T120000Z-rare-album-abcdef"
            part = root / f".{recording_id}.wav.part"
            part.write_bytes(wav_header(0) + payload(123) + b"x")

            store = RecordingStore(root, now=FixedTime())

            saved = store.list_saved()
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0]["state"], "interrupted")
            self.assertEqual(saved[0]["frames"], DEFAULT_FORMAT.frames_per_packet)
            self.assertFalse(part.exists())
            opened = store.open_file(recording_id)
            with opened.source, wave.open(opened.source, "rb") as recording:
                self.assertEqual(recording.getnframes(), DEFAULT_FORMAT.frames_per_packet)

    def test_recording_ids_cannot_escape_the_owned_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = RecordingStore(Path(tmp), now=FixedTime())
            with self.assertRaisesRegex(Exception, "not found"):
                store.open_file("../outside")

    def test_startup_rebuilds_a_missing_manifest_from_the_wav(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recording_id = "20260711T120000Z-rare-album-abcdef"
            wav_path = root / f"{recording_id}.wav"
            wav_path.write_bytes(wav_header(DEFAULT_FORMAT.payload_bytes) + payload(123))

            store = RecordingStore(root, now=FixedTime())

            saved = store.list_saved()
            self.assertEqual(len(saved), 1)
            self.assertEqual(saved[0]["frames"], DEFAULT_FORMAT.frames_per_packet)
            self.assertIn("manifest was missing", str(saved[0]["error"]))

    def test_store_refuses_a_symlink_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            target = base / "target"
            target.mkdir()
            link = base / "recordings"
            link.symlink_to(target, target_is_directory=True)

            with self.assertRaises(RecordingError):
                RecordingStore(link)

    def test_part_creation_does_not_follow_a_precreated_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sentinel = root / "sentinel"
            sentinel.write_text("keep me", encoding="utf-8")
            store = RecordingStore(root, now=FixedTime())
            paths = store.paths("20260711T120000Z-rare-album-abcdef")
            paths.part.symlink_to(sentinel)

            with self.assertRaises(OSError):
                WavRecordingFile(store, paths)

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me")

    def test_download_does_not_follow_a_recording_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sentinel = root / "sentinel"
            sentinel.write_text("private host data", encoding="utf-8")
            store = RecordingStore(root, now=FixedTime())
            recording_id = "20260711T120000Z-rare-album-abcdef"
            store.paths(recording_id).wav.symlink_to(sentinel)

            with self.assertRaises(RecordingError):
                store.open_file(recording_id)

    def test_recovery_does_not_modify_a_hard_linked_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sentinel = root / "sentinel"
            sentinel.write_bytes(wav_header(0) + payload(123) + b"unaligned")
            linked_part = root / ".20260711T120000Z-rare-album-abcdef.wav.part"
            os.link(sentinel, linked_part)

            RecordingStore(root, now=FixedTime())

            self.assertEqual(sentinel.read_bytes(), wav_header(0) + payload(123) + b"unaligned")

    def test_untrusted_manifest_is_bounded_and_validated(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            recording_id = "20260711T120000Z-rare-album-abcdef"
            wav_path = root / f"{recording_id}.wav"
            wav_path.write_bytes(wav_header(DEFAULT_FORMAT.payload_bytes) + payload(123))
            store = RecordingStore(root, now=FixedTime())
            manifest_path = root / f"{recording_id}.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["title"] = {"not": "a string"}
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            self.assertEqual(store.list_saved(), [])

            manifest_path.write_bytes(b"x" * (64 * 1024 + 1))
            self.assertEqual(store.list_saved(), [])

    def test_store_keeps_using_the_pinned_directory_after_path_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            root = base / "recordings"
            store = RecordingStore(root, now=FixedTime())
            pinned = base / "pinned"
            root.rename(pinned)
            root.mkdir()
            paths = store.paths("20260711T120000Z-rare-album-abcdef")

            output = WavRecordingFile(store, paths)
            output.append(payload(123))
            output.finalize()

            self.assertTrue((pinned / paths.wav.name).is_file())
            self.assertEqual(list(root.iterdir()), [])
