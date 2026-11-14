"""Bridge command-line and Home Assistant option contract."""

from __future__ import annotations

import argparse
import ipaddress
import math
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

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
    maximum: int | float | None = None

    @property
    def supervisor_schema(self) -> str:
        if self.value_type is str:
            return "str"
        if self.value_type is bool:
            return "bool"
        if self.minimum is None:
            raise ValueError(f"numeric option {self.name} requires a minimum")
        type_name = "int" if self.value_type is int else "float"
        maximum = "" if self.maximum is None else str(self.maximum)
        return f"{type_name}({self.minimum},{maximum})"


@dataclass(frozen=True)
class AddonControlOption:
    """An add-on-only setting consumed before the bridge process starts."""

    name: str
    default: bool | str
    supervisor_schema: str


BRIDGE_OPTIONS = (
    BridgeOption("tcp_bind", "--tcp-bind", str, "0.0.0.0", "TCP bind address"),
    BridgeOption("tcp_port", "--tcp-port", int, DEFAULT_PORT, "PCM listen port", minimum=1, maximum=65535),
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
    BridgeOption(
        "bridge_name",
        "--bridge-name",
        str,
        "StreamLine Bridge",
        "name devices list for this bridge when they discover it on the network",
        addon=True,
    ),
    BridgeOption("http_bind", "--http-bind", str, "0.0.0.0", "HTTP bind address"),
    BridgeOption("http_port", "--http-port", int, 8088, "HTTP listen port", minimum=1, maximum=65535),
    BridgeOption(
        "public_url",
        "--public-url",
        str,
        "",
        "player-accessible HTTP base URL, outside authenticated ingress",
        addon=True,
    ),
    BridgeOption(
        "max_http_connections",
        "--max-http-connections",
        int,
        32,
        "maximum simultaneous HTTP clients",
        minimum=1,
        addon=True,
        maximum=128,
    ),
    BridgeOption(
        "http_request_timeout_seconds",
        "--http-request-timeout-seconds",
        float,
        10.0,
        "disconnect an HTTP client after this many seconds without socket progress",
        minimum=0.001,
        addon=True,
        maximum=3600.0,
    ),
    BridgeOption(
        "sendspin_server_url",
        "--sendspin-server-url",
        str,
        "",
        "Music Assistant Sendspin server URL (ws://host:8927/sendspin) that receives every source as a live input; "
        "publishing is disabled when empty",
        addon=True,
    ),
    BridgeOption(
        "sendspin_state_dir",
        "--sendspin-state-dir",
        str,
        "",
        "private directory for Sendspin client identities and pairings; required with --sendspin-server-url",
    ),
    BridgeOption(
        "recordings_dir",
        "--recordings-dir",
        str,
        "",
        "writable directory for lossless recordings; disabled when empty",
    ),
    BridgeOption(
        "client_buffer_chunks",
        "--client-buffer-chunks",
        int,
        2048,
        "per-client HTTP output queue depth",
        minimum=1,
        addon=True,
        maximum=4096,
    ),
    BridgeOption(
        "playout_buffer_seconds",
        "--playout-buffer-seconds",
        float,
        1.0,
        "minimum receiver jitter buffer before playout starts",
        minimum=0.001,
        addon=True,
        maximum=60.0,
    ),
    BridgeOption(
        "max_playout_buffer_seconds",
        "--max-playout-buffer-seconds",
        float,
        3.0,
        "maximum adaptive receiver jitter buffer; equal to minimum disables adaptation",
        minimum=0.001,
        addon=True,
        maximum=60.0,
    ),
    BridgeOption(
        "max_repeat_conceal_packets",
        "--max-repeat-conceal-packets",
        int,
        3,
        "repeat the previous packet this many times before filling loss with silence",
        minimum=0,
        addon=True,
        maximum=256,
    ),
    BridgeOption(
        "max_outage_silence_seconds",
        "--max-outage-silence-seconds",
        float,
        5.0,
        "after this much concealed outage, pause playout and wait to re-buffer",
        minimum=0.001,
        addon=True,
        maximum=300.0,
    ),
    BridgeOption(
        "source_idle_timeout_seconds",
        "--source-idle-timeout-seconds",
        float,
        5.0,
        "producer read deadline and TCP keepalive interval; established streams may gate silence",
        minimum=0.001,
        addon=True,
        maximum=3600.0,
    ),
    BridgeOption(
        "source_eviction_idle_seconds",
        "--source-eviction-idle-seconds",
        float,
        300.0,
        "evict an idle disconnected dynamic source after this many seconds",
        minimum=0.001,
        addon=True,
        maximum=86400.0,
    ),
    BridgeOption(
        "max_sources",
        "--max-sources",
        int,
        8,
        "maximum number of producer pipelines to keep",
        minimum=1,
        addon=True,
        maximum=32,
    ),
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
    args.bridge_name = validate_bridge_name(args.bridge_name)
    args.public_url = validate_public_url(args.public_url)
    args.sendspin_server_url = validate_sendspin_server_url(args.sendspin_server_url)
    if args.sendspin_server_url and not args.sendspin_state_dir:
        raise SystemExit("--sendspin-server-url requires --sendspin-state-dir")
    for option in BRIDGE_OPTIONS:
        if option.name == "source_allow" or option.minimum is None:
            continue
        _validate_numeric(option, getattr(args, option.name))

    if args.max_playout_buffer_seconds < args.playout_buffer_seconds:
        raise SystemExit("--max-playout-buffer-seconds must be at least --playout-buffer-seconds")

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


# A DNS label holds 63 bytes; a name conflict appends `-NN`.
MAX_BRIDGE_NAME_BYTES = 60


def validate_bridge_name(value: str) -> str:
    """Accept a DNS-SD instance name that stays one DNS label after a conflict rename."""
    name = value.strip()
    if (
        not name
        or len(name.encode()) > MAX_BRIDGE_NAME_BYTES
        or "." in name
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        raise SystemExit(
            f"--bridge-name must be 1 to {MAX_BRIDGE_NAME_BYTES} bytes of UTF-8 text without dots or control characters"
        )
    return name


def validate_public_url(value: str) -> str:
    """Accept a bounded credential-free HTTP base address for external players."""
    if not value:
        return ""
    if not _is_plain_url(value, {"http", "https"}) or "\\" in value or "/api/hassio_ingress/" in urlsplit(value).path:
        raise SystemExit(
            "--public-url must be a player-accessible HTTP(S) base URL without credentials, query, or fragment"
        )
    return value.rstrip("/")


def validate_sendspin_server_url(value: str) -> str:
    """Accept a bounded credential-free WebSocket URL for a Sendspin server."""
    if value and not _is_plain_url(value, {"ws", "wss"}):
        raise SystemExit("--sendspin-server-url must be a ws:// or wss:// URL without credentials, query, or fragment")
    return value


def _is_plain_url(value: str, schemes: set[str]) -> bool:
    """Whether ``value`` is a bounded URL with a host and no credentials, query, or fragment."""
    if len(value) > 2048 or any(character.isspace() or ord(character) < 32 for character in value):
        return False
    try:
        url = urlsplit(value)
        port = url.port
    except ValueError:
        return False
    return (
        url.scheme in schemes
        and bool(url.hostname)
        and url.username is None
        and url.password is None
        and not url.query
        and not url.fragment
        and (port is None or port >= 1)
    )


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
        _validate_numeric(option, value)
    return str(value).lower() if isinstance(value, bool) else str(value)


def _validate_numeric(option: BridgeOption, value: int | float) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise SystemExit(f"{option.flag} must be finite")
    if option.minimum is not None and value < option.minimum:
        raise SystemExit(f"{option.flag} must be at least {option.minimum}")
    if option.maximum is not None and value > option.maximum:
        raise SystemExit(f"{option.flag} must be at most {option.maximum}")


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected true or false")
