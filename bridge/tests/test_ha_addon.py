from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from streamline_bridge.ha_addon import bridge_argv, load_options, normalize_source_allow


class HomeAssistantAddonOptionTests(unittest.TestCase):
    def test_bridge_argv_maps_addon_options_to_bridge_flags(self) -> None:
        argv = bridge_argv(
            {
                "source_allow": "192.0.2.10, 198.51.100.20",
                "max_sources": 2,
                "client_buffer_chunks": 1024,
                "playout_buffer_seconds": 0.5,
                "max_repeat_conceal_packets": 4,
                "max_outage_silence_seconds": 3.5,
                "source_idle_timeout_seconds": 8.0,
            }
        )

        self.assertEqual(
            argv,
            [
                "streamline-bridge",
                "--source-allow",
                "192.0.2.10,198.51.100.20",
                "--max-sources",
                "2",
                "--client-buffer-chunks",
                "1024",
                "--playout-buffer-seconds",
                "0.5",
                "--max-repeat-conceal-packets",
                "4",
                "--max-outage-silence-seconds",
                "3.5",
                "--source-idle-timeout-seconds",
                "8.0",
            ],
        )

    def test_blank_source_allow_is_omitted(self) -> None:
        self.assertEqual(
            bridge_argv({"source_allow": "", "max_sources": 8}),
            ["streamline-bridge", "--max-sources", "8"],
        )

    def test_source_allow_accepts_a_list(self) -> None:
        self.assertEqual(
            normalize_source_allow(["192.0.2.10", " 198.51.100.20 ", ""]),
            "192.0.2.10,198.51.100.20",
        )

    def test_load_options_reads_json_object(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "options.json"
            path.write_text('{"max_sources": 3}\n', encoding="utf-8")

            self.assertEqual(load_options(path), {"max_sources": 3})

    def test_missing_options_file_runs_with_bridge_defaults(self) -> None:
        self.assertEqual(load_options(Path("/tmp/streamline-missing-options.json")), {})

    def test_rejects_non_object_options_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "options.json"
            path.write_text("[]\n", encoding="utf-8")

            with self.assertRaises(SystemExit):
                load_options(path)
