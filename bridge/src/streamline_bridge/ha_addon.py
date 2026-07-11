"""Home Assistant add-on option adapter for the StreamLine bridge."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NoReturn

from streamline_bridge.options import addon_options, option_value

BRIDGE_EXECUTABLE = "streamline-bridge"
OPTIONS_PATH = Path("/data/options.json")


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
    known_options = {option.name for option in addon_options()}
    unknown_options = sorted(set(options) - known_options)
    if unknown_options:
        raise SystemExit(f"unknown Home Assistant option(s): {', '.join(unknown_options)}")
    argv = [BRIDGE_EXECUTABLE]

    source_allow = normalize_source_allow(options.get("source_allow", ""))
    if source_allow:
        argv.extend(("--source-allow", source_allow))

    for option in addon_options():
        if option.name != "source_allow" and option.name in options:
            argv.extend((option.flag, option_value(options, option)))

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
