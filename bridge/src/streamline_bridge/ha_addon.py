"""Home Assistant add-on option adapter for the StreamLine bridge."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NoReturn

from streamline_bridge.options import ADDON_CONTROL_OPTIONS, addon_options, option_value

BRIDGE_EXECUTABLE = "streamline-bridge"
OPTIONS_PATH = Path("/data/options.json")
RECORDINGS_DIR = "/data/recordings"
API_TOKEN_ENV = "STREAMLINE_API_TOKEN"
TRANSPORT_STATE_FILE = "/data/transport.json"


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
    known_options = {option.name for option in addon_options()} | {option.name for option in ADDON_CONTROL_OPTIONS}
    unknown_options = sorted(set(options) - known_options)
    if unknown_options:
        raise SystemExit(f"unknown Home Assistant option(s): {', '.join(unknown_options)}")
    argv = [BRIDGE_EXECUTABLE, "--transport-state-file", TRANSPORT_STATE_FILE]

    if recordings_enabled(options):
        if not api_token(options):
            raise SystemExit("api_token is required when recordings are enabled")
        argv.extend(("--recordings-dir", RECORDINGS_DIR))

    source_allow = normalize_source_allow(options.get("source_allow", ""))
    if source_allow:
        argv.extend(("--source-allow", source_allow))

    for option in addon_options():
        if option.name != "source_allow" and option.name in options:
            argv.extend((option.flag, option_value(options, option)))

    return argv


def recordings_enabled(options: dict[str, object]) -> bool:
    enabled = options.get("recordings_enabled", False)
    if not isinstance(enabled, bool):
        raise SystemExit("recordings_enabled must be a boolean")
    return enabled


def api_token(options: dict[str, object]) -> str:
    token = options.get("api_token", "")
    if not isinstance(token, str):
        raise SystemExit("api_token must be a string")
    if token and len(token) < 16:
        raise SystemExit("api_token must contain at least 16 characters")
    return token


def bridge_environment(options: dict[str, object]) -> dict[str, str]:
    token = api_token(options)
    return {API_TOKEN_ENV: token} if token else {}


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
    options = load_options()
    argv = bridge_argv(options)
    environment = os.environ | bridge_environment(options)
    os.execvpe(argv[0], argv, environment)
    raise SystemExit(127)
