"""Bridge command-line and Home Assistant option contract."""

from __future__ import annotations

import argparse
import ipaddress
import os
from dataclasses import dataclass

from streamline_bridge.transport import DEFAULT_PORT


@dataclass(frozen=True)
class BridgeOption:
    """One bridge setting and every boundary that exposes it."""

    name: str
    flag: str
    value_type: type[bool] | type[int] | type[float] | type[str]
    default: bool | int | float | str
    help: str
    minimum: int | float | None = None
    addon: bool = False

    @property
    def supervisor_schema(self) -> str:
        if self.value_type is str:
            return "str"
        if self.value_type is bool:
            return "bool"
        if self.minimum is None:
            raise ValueError(f"numeric option {self.name} requires a minimum")
        type_name = "int" if self.value_type is int else "float"
        return f"{type_name}({self.minimum},)"


@dataclass(frozen=True)
class AddonControlOption:
    """An add-on-only setting consumed before the bridge process starts."""

    name: str
    default: bool | str
    supervisor_schema: str


BRIDGE_OPTIONS = (
    BridgeOption("tcp_bind", "--tcp-bind", str, "0.0.0.0", "TCP bind address"),
    BridgeOption("tcp_port", "--tcp-port", int, DEFAULT_PORT, "PCM listen port", minimum=1),
    BridgeOption(
        "transport_state_file",
        "--transport-state-file",
        str,
        "",
        "private transport state file (listener mode and device keys); encryption control is disabled when empty",
    ),
    BridgeOption(
        "source_allow",
        "--source-allow",
        str,
        "",
        "allow only these IPv4 source addresses; repeat or use a comma-separated list",
        addon=True,
    ),
    BridgeOption("http_bind", "--http-bind", str, "0.0.0.0", "HTTP bind address"),
    BridgeOption("http_port", "--http-port", int, 8088, "HTTP listen port", minimum=1),
    BridgeOption(
        "max_http_connections",
        "--max-http-connections",
        int,
        32,
        "maximum simultaneous HTTP clients",
        minimum=1,
        addon=True,
    ),
    BridgeOption(
        "http_request_timeout_seconds",
        "--http-request-timeout-seconds",
        float,
        10.0,
        "disconnect an HTTP client after this many seconds without socket progress",
        minimum=0.001,
        addon=True,
    ),
    BridgeOption(
        "recordings_dir",
        "--recordings-dir",
        str,
        "",
        "writable directory for lossless recordings; disabled when empty",
    ),
    BridgeOption(
        "client_buffer_chunks", "--client-buffer-chunks", int, 2048, "per-client HTTP output queue depth", 1, True
    ),
    BridgeOption(
        "playout_buffer_seconds",
        "--playout-buffer-seconds",
        float,
        1.0,
        "receiver jitter buffer before playout starts",
        0.001,
        True,
    ),
    BridgeOption(
        "max_repeat_conceal_packets",
        "--max-repeat-conceal-packets",
        int,
        3,
        "repeat the previous packet this many times before filling loss with silence",
        0,
        True,
    ),
    BridgeOption(
        "max_outage_silence_seconds",
        "--max-outage-silence-seconds",
        float,
        5.0,
        "after this much concealed outage, pause playout and wait to re-buffer",
        0.001,
        True,
    ),
    BridgeOption(
        "source_idle_timeout_seconds",
        "--source-idle-timeout-seconds",
        float,
        5.0,
        "drop an inactive TCP producer after this many seconds",
        0.001,
        True,
    ),
    BridgeOption(
        "source_eviction_idle_seconds",
        "--source-eviction-idle-seconds",
        float,
        300.0,
        "evict an idle disconnected dynamic source after this many seconds",
        0.001,
        True,
    ),
    BridgeOption("max_sources", "--max-sources", int, 8, "maximum number of producer pipelines to keep", 1, True),
)

OPTIONS_BY_NAME = {option.name: option for option in BRIDGE_OPTIONS}
ADDON_CONTROL_OPTIONS = (
    AddonControlOption("recordings_enabled", False, "bool"),
    AddonControlOption("api_token", "", "password"),
)


def addon_options() -> tuple[BridgeOption, ...]:
    """Return options Home Assistant exposes to the bridge."""
    return tuple(option for option in BRIDGE_OPTIONS if option.addon)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse bridge CLI arguments from the shared option contract."""
    parser = argparse.ArgumentParser(description="Bridge ESP32 StreamLine TCP PCM packets to a live HTTP WAV stream.")
    for option in BRIDGE_OPTIONS:
        if option.name == "source_allow":
            parser.add_argument(
                option.flag,
                action="append",
                default=[os.environ.get("STREAMLINE_SOURCE_ALLOW", "")],
                metavar="IP",
                help=option.help,
            )
        else:
            default = (
                os.environ.get("STREAMLINE_RECORDINGS_DIR", str(option.default))
                if option.name == "recordings_dir"
                else option.default
            )
            parser.add_argument(
                option.flag,
                type=parse_bool if option.value_type is bool else option.value_type,
                default=default,
                help=option.help,
            )
    return parser.parse_args(argv)


def validate_args(args: argparse.Namespace) -> argparse.Namespace:
    """Validate values that argparse and Supervisor cannot express alone."""
    for option in BRIDGE_OPTIONS:
        if option.name == "source_allow" or option.minimum is None:
            continue
        if getattr(args, option.name) < option.minimum:
            comparator = "at least" if option.minimum >= 1 else "greater than"
            raise SystemExit(f"{option.flag} must be {comparator} {option.minimum}")

    try:
        args.source_allow = frozenset(
            str(ipaddress.IPv4Address(source.strip()))
            for value in args.source_allow
            for source in value.split(",")
            if source.strip()
        )
    except ipaddress.AddressValueError as exc:
        raise SystemExit(f"--source-allow must be an IPv4 address: {exc}") from exc
    if len(args.source_allow) > args.max_sources:
        raise SystemExit("--max-sources must be at least the number of allowed sources")
    return args


def option_value(options: dict[str, object], option: BridgeOption) -> str:
    """Validate and serialize a Supervisor value for one bridge flag."""
    value = options[option.name]
    if option.value_type is str:
        if not isinstance(value, str):
            raise SystemExit(f"{option.name} must be a string")
    elif option.value_type is bool:
        if not isinstance(value, bool):
            raise SystemExit(f"{option.name} must be a boolean")
    elif option.value_type is int:
        if not isinstance(value, int) or isinstance(value, bool):
            raise SystemExit(f"{option.name} must be an integer")
    elif not isinstance(value, (int, float)) or isinstance(value, bool):
        raise SystemExit(f"{option.name} must be a number")
    if option.minimum is not None and isinstance(value, (int, float)):
        numeric_value = float(value)
        if numeric_value < option.minimum:
            raise SystemExit(f"{option.name} must be at least {option.minimum}")
    return str(value).lower() if isinstance(value, bool) else str(value)


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected true or false")
