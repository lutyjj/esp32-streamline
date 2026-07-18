from __future__ import annotations

from pathlib import Path

from recording_fixtures import FixedTime, RecordingServiceHarness, payload

from streamline_bridge.recording import RecordingStore


class RecordingServiceTests(RecordingServiceHarness):
    """Orchestration: leases, per-source exclusivity, and identity handoff."""

    def test_one_active_session_per_source_but_other_sources_remain_independent(self) -> None:
        first = self.service.start("192.0.2.10", "First")
        with self.assertRaisesRegex(Exception, "already recording"):
            self.service.start("192.0.2.10", "Duplicate")
        other = self.connect_source("192.0.2.11")
        second = self.service.start("192.0.2.11", "Second")
        self.source.hub.ingest(1, payload(1))
        other.hub.ingest(1, payload(2))

        self.assertEqual(self.service.stop(first["id"])["state"], "complete")
        self.assertEqual(self.service.stop(second["id"])["state"], "complete")

    def test_tls_key_identity_is_persisted_and_valid_after_store_reopen(self) -> None:
        key_id = "eli1-00112233445566778899aabbccddeeff"
        source = self.connect_source(key_id, peer_ip="192.0.2.20", transport="tls-psk")
        started = self.service.start(key_id, "Encrypted source")
        source.hub.ingest(1, payload(123))

        stopped = self.service.stop(started["id"])
        reopened = RecordingStore(Path(self.temp.name), now=FixedTime())

        self.assertEqual(stopped["source"], key_id)
        self.assertEqual(reopened.list_saved()[0]["source"], key_id)
        opened = reopened.open_file(started["id"])
        with opened.source:
            self.assertEqual(opened.source.read(4), b"RIFF")
        reopened.delete(started["id"])
        self.assertEqual(reopened.list_saved(), [])
