from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from streamline_bridge.ha_addon import bridge_argv, bridge_environment, load_options, normalize_source_allow
from streamline_bridge.options import (
    ADDON_CONTROL_OPTIONS,
    AddonControlOption,
    BridgeOption,
    addon_options,
    parse_args,
    validate_args,
)


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
                "--transport-state-file",
                "/data/transport.json",
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
            ["streamline-bridge", "--transport-state-file", "/data/transport.json", "--max-sources", "8"],
        )

    def test_recordings_use_private_storage_and_keep_the_token_out_of_argv(self) -> None:
        options = {"recordings_enabled": True, "api_token": "long-bridge-api-token"}

        self.assertEqual(
            bridge_argv(options),
            [
                "streamline-bridge",
                "--transport-state-file",
                "/data/transport.json",
                "--recordings-dir",
                "/data/recordings",
            ],
        )
        self.assertEqual(bridge_environment(options), {"STREAMLINE_API_TOKEN": "long-bridge-api-token"})

    def test_enabled_recordings_require_a_token(self) -> None:
        with self.assertRaisesRegex(SystemExit, "api_token is required"):
            bridge_argv({"recordings_enabled": True})

    def test_a_set_token_must_be_long_enough(self) -> None:
        with self.assertRaisesRegex(SystemExit, "at least 16 characters"):
            bridge_argv({"recordings_enabled": True, "api_token": "short"})
        with self.assertRaisesRegex(SystemExit, "at least 16 characters"):
            bridge_environment({"api_token": "short"})

    def test_an_unset_token_exports_no_environment(self) -> None:
        self.assertEqual(bridge_environment({}), {})

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

    def test_cli_ports_accept_only_the_socket_port_range(self) -> None:
        for flag in ("--tcp-port", "--http-port"):
            for accepted in (1, 65535):
                with self.subTest(flag=flag, accepted=accepted):
                    self.assertEqual(
                        getattr(validate_args(parse_args([flag, str(accepted)])), flag[2:].replace("-", "_")), accepted
                    )
            for rejected in (0, 65536):
                with self.subTest(flag=flag, rejected=rejected), self.assertRaises(SystemExit):
                    validate_args(parse_args([flag, str(rejected)]))

    def test_cli_and_addon_reject_nonfinite_floats_with_the_same_message(self) -> None:
        flag = "--playout-buffer-seconds"
        for raw in ("nan", "inf", "-inf"):
            with self.subTest(raw=raw):
                with self.assertRaises(SystemExit) as cli:
                    validate_args(parse_args([f"{flag}={raw}"]))
                with self.assertRaises(SystemExit) as addon:
                    bridge_argv({"playout_buffer_seconds": float(raw)})
                self.assertEqual(str(cli.exception), str(addon.exception))
                self.assertEqual(str(cli.exception), f"{flag} must be finite")

    def test_cli_and_addon_share_resource_maximum_errors(self) -> None:
        cases = {
            "max_sources": 33,
            "max_http_connections": 129,
            "client_buffer_chunks": 4097,
        }
        for name, rejected in cases.items():
            flag = f"--{name.replace('_', '-')}"
            with self.subTest(name=name):
                with self.assertRaises(SystemExit) as cli:
                    validate_args(parse_args([flag, str(rejected)]))
                with self.assertRaises(SystemExit) as addon:
                    bridge_argv({name: rejected})
                self.assertEqual(str(cli.exception), str(addon.exception))

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
