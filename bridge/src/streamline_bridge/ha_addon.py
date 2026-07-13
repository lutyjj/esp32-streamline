"""Home Assistant add-on option adapter for the StreamLine bridge."""

from __future__ import annotations

import json
import logging
import os
import socket
from collections.abc import Mapping
from pathlib import Path
from typing import NoReturn
from urllib.error import URLError
from urllib.request import Request, urlopen

from streamline_bridge.options import ADDON_CONTROL_OPTIONS, addon_options, option_value

BRIDGE_EXECUTABLE = "streamline-bridge"
OPTIONS_PATH = Path("/data/options.json")
RECORDINGS_DIR = "/data/recordings"
RECORDING_TOKEN_ENV = "STREAMLINE_RECORDING_TOKEN"
SUPERVISOR_TOKEN_ENV = "SUPERVISOR_TOKEN"
SUPERVISOR_DISCOVERY_URL = "http://supervisor/discovery"
DISCOVERY_SERVICE = "streamline"
HTTP_PORT = 8088

LOGGER = logging.getLogger(__name__)


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
    argv = [BRIDGE_EXECUTABLE]

    if recordings_enabled(options):
        validate_recording_token(options)
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


def validate_recording_token(options: dict[str, object]) -> str:
    token = options.get("recording_token", "")
    if not isinstance(token, str):
        raise SystemExit("recording_token must be a string")
    if len(token) < 16:
        raise SystemExit("recording_token must contain at least 16 characters when recordings are enabled")
    return token


def recording_environment(options: dict[str, object]) -> dict[str, str]:
    if not recordings_enabled(options):
        return {}
    return {RECORDING_TOKEN_ENV: validate_recording_token(options)}


def discovery_config(options: dict[str, object], hostname: str) -> dict[str, object]:
    """Build the Supervisor-to-integration handoff without logging credentials."""
    config: dict[str, object] = {"host": hostname, "port": HTTP_PORT}
    if recordings_enabled(options):
        config["recording_token"] = validate_recording_token(options)
    return config


def publish_discovery(options: dict[str, object], environment: Mapping[str, str] = os.environ) -> bool:
    """Publish best-effort Supervisor discovery for the HACS integration."""
    supervisor_token = environment.get(SUPERVISOR_TOKEN_ENV, "")
    if not supervisor_token:
        return False
    body = json.dumps(
        {"service": DISCOVERY_SERVICE, "config": discovery_config(options, socket.gethostname())}
    ).encode()
    request = Request(
        SUPERVISOR_DISCOVERY_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {supervisor_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=5) as response:
            return int(response.status) == 200
    except (OSError, URLError):
        LOGGER.warning("Could not publish StreamLine discovery to Home Assistant")
        return False


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
    environment = os.environ | recording_environment(options)
    publish_discovery(options, environment)
    os.execvpe(argv[0], argv, environment)
    raise SystemExit(127)
