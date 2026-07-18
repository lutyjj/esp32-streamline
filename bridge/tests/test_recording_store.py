from __future__ import annotations

import json
import os
import tempfile
import unittest
import wave
from pathlib import Path

from recording_fixtures import FixedTime, payload

from streamline_bridge.protocol import DEFAULT_FORMAT
from streamline_bridge.recording import RecordingError, RecordingStore, WavRecordingFile, wav_header


class RecordingStoreTests(unittest.TestCase):
    """Storage boundary: recovery, untrusted artifacts, and the pinned root."""

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

    def test_repeated_directory_scans_see_new_recordings(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = RecordingStore(root, now=FixedTime())
            self.assertEqual(store.list_saved(), [])
            recording_id = "20260711T120000Z-rare-album-abcdef"
            (root / f"{recording_id}.wav").write_bytes(wav_header(DEFAULT_FORMAT.payload_bytes) + payload(123))

            store.recover()

            self.assertEqual(len(store.list_saved()), 1)

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

            manifest["title"] = "Rare album"
            manifest["source"] = "device.local"
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
