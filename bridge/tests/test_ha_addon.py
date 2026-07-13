from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import URLError

from streamline_bridge.ha_addon import (
    bridge_argv,
    discovery_config,
    load_options,
    normalize_source_allow,
    publish_discovery,
    recording_environment,
)
from streamline_bridge.options import ADDON_CONTROL_OPTIONS, AddonControlOption, BridgeOption, addon_options


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
                "source_eviction_idle_seconds": 120.0,
            }
        )

        self.assertEqual(
            argv,
            [
                "streamline-bridge",
                "--source-allow",
                "192.0.2.10,198.51.100.20",
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
                "--source-eviction-idle-seconds",
                "120.0",
                "--max-sources",
                "2",
            ],
        )

    def test_blank_source_allow_is_omitted(self) -> None:
        self.assertEqual(
            bridge_argv({"source_allow": "", "max_sources": 8}),
            ["streamline-bridge", "--max-sources", "8"],
        )

    def test_recording_options_enable_private_storage_without_putting_the_token_in_argv(self) -> None:
        options = {"recordings_enabled": True, "recording_token": "long-recording-token"}

        self.assertEqual(
            bridge_argv(options),
            ["streamline-bridge", "--recordings-dir", "/data/recordings"],
        )
        self.assertEqual(recording_environment(options), {"STREAMLINE_RECORDING_TOKEN": "long-recording-token"})

    def test_enabled_recordings_require_a_long_token(self) -> None:
        with self.assertRaisesRegex(SystemExit, "at least 16 characters"):
            bridge_argv({"recordings_enabled": True, "recording_token": "short"})

    def test_discovery_hands_the_internal_bridge_and_recording_token_to_home_assistant(self) -> None:
        options = {"recordings_enabled": True, "recording_token": "long-recording-token"}

        self.assertEqual(
            discovery_config(options, "streamline-addon"),
            {
                "host": "streamline-addon",
                "port": 8088,
                "recording_token": "long-recording-token",
            },
        )

    @patch("streamline_bridge.ha_addon.socket.gethostname", return_value="streamline-addon")
    @patch("streamline_bridge.ha_addon.urlopen")
    def test_discovery_uses_the_supervisor_api_without_exposing_the_token_in_the_url(
        self, open_url: MagicMock, _hostname: MagicMock
    ) -> None:
        response = MagicMock()
        response.__enter__.return_value.status = 200
        open_url.return_value = response

        published = publish_discovery(
            {"recordings_enabled": True, "recording_token": "long-recording-token"},
            {"SUPERVISOR_TOKEN": "test-supervisor-token"},
        )

        self.assertTrue(published)
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://supervisor/discovery")
        self.assertNotIn("long-recording-token", request.full_url)
        self.assertIn(b'"service": "streamline"', request.data)
        self.assertIn(b'"recording_token": "long-recording-token"', request.data)

    def test_missing_supervisor_token_does_not_block_bridge_startup(self) -> None:
        self.assertFalse(publish_discovery({}, {}))

    @patch("streamline_bridge.ha_addon.urlopen", side_effect=URLError("offline"))
    def test_supervisor_failure_does_not_block_bridge_startup(self, _open_url: MagicMock) -> None:
        self.assertFalse(publish_discovery({}, {"SUPERVISOR_TOKEN": "test-supervisor-token"}))

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

    def test_unknown_supervisor_options_fail_clearly(self) -> None:
        with self.assertRaisesRegex(SystemExit, "unknown Home Assistant option"):
            bridge_argv({"not_a_bridge_option": True})

    def test_supervisor_config_matches_the_bridge_owned_option_contract(self) -> None:
        config_path = Path(
            os.environ.get("STREAMLINE_ADDON_CONFIG", Path(__file__).parents[2] / "ha-addon" / "config.yaml")
        )
        config = config_path.read_text(encoding="utf-8")
        options = self._yaml_section(config, "options")
        schema = self._yaml_section(config, "schema")
        contract: dict[str, BridgeOption | AddonControlOption] = {option.name: option for option in addon_options()}
        contract.update({option.name: option for option in ADDON_CONTROL_OPTIONS})
        self.assertEqual(set(options), set(contract))
        self.assertEqual(set(schema), set(contract))
        for name, option in contract.items():
            self.assertEqual(options[name], str(option.default).lower())
            self.assertEqual(schema[name], option.supervisor_schema)

    def test_supervisor_config_keeps_recordings_private_and_out_of_backups(self) -> None:
        config_path = Path(
            os.environ.get("STREAMLINE_ADDON_CONFIG", Path(__file__).parents[2] / "ha-addon" / "config.yaml")
        )
        config = config_path.read_text(encoding="utf-8")

        self.assertNotIn("\nmap:\n", config)
        self.assertIn("\nbackup_exclude:\n  - recordings\n", config)
        self.assertIn("\ndiscovery:\n  - streamline\n", config)
        self.assertNotIn("hassio_api", config)

    @staticmethod
    def _yaml_section(config: str, name: str) -> dict[str, str]:
        lines = config.splitlines()
        start = lines.index(f"{name}:") + 1
        result: dict[str, str] = {}
        for line in lines[start:]:
            if line and not line.startswith("  "):
                break
            if line.startswith("  "):
                key, value = line.strip().split(": ", 1)
                result[key] = value.strip('"')
        return result
