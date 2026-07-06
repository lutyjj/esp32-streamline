"""Home Assistant add-on option adapter for the StreamLine bridge."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NoReturn

BRIDGE_EXECUTABLE = "streamline-bridge"
OPTIONS_PATH = Path("/data/options.json")

BRIDGE_OPTION_FLAGS = (
    ("max_sources", "--max-sources"),
    ("client_buffer_chunks", "--client-buffer-chunks"),
    ("playout_buffer_seconds", "--playout-buffer-seconds"),
    ("max_repeat_conceal_packets", "--max-repeat-conceal-packets"),
    ("max_outage_silence_seconds", "--max-outage-silence-seconds"),
    ("source_idle_timeout_seconds", "--source-idle-timeout-seconds"),
)


def load_options(path: Path = OPTIONS_PATH) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise SystemExit(f"{path} must contain a JSON object")
    return data


def bridge_argv(options: dict[str, object]) -> list[str]:
    argv = [BRIDGE_EXECUTABLE]

    source_allow = normalize_source_allow(options.get("source_allow", ""))
    if source_allow:
        argv.extend(("--source-allow", source_allow))

    for option_name, flag in BRIDGE_OPTION_FLAGS:
        value = options.get(option_name)
        if value is not None:
            argv.extend((flag, str(value)))

    return argv


def normalize_source_allow(value: object) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, list):
        parts = value
    else:
        raise SystemExit("source_allow must be a string or a list of strings")

    sources: list[str] = []
    for part in parts:
        if not isinstance(part, str):
            raise SystemExit("source_allow entries must be strings")
        source = part.strip()
        if source:
            sources.append(source)
    return ",".join(sources)


def main() -> NoReturn:
    argv = bridge_argv(load_options())
    os.execvp(argv[0], argv)
    raise SystemExit(127)
