"""Canonical source identities shared across bridge boundaries."""

from __future__ import annotations

import ipaddress
import re
from typing import Final

TRANSPORT_KEY_ID_PATTERN_TEXT: Final = r"^eli1-[0-9a-f]{32}$"
TRANSPORT_KEY_ID_PATTERN = re.compile(TRANSPORT_KEY_ID_PATTERN_TEXT)
RECOVERY_SOURCE_ID: Final = "unknown"


def parse_source_identity(value: str, *, allow_recovery: bool = False) -> str:
    """Return one canonical IPv4 address, transport key id, or recovery id."""
    if allow_recovery and value == RECOVERY_SOURCE_ID:
        return value
    try:
        return str(ipaddress.IPv4Address(value))
    except ipaddress.AddressValueError:
        if TRANSPORT_KEY_ID_PATTERN.fullmatch(value):
            return value
    raise ValueError("source must be an IPv4 address or PCM transport key id")
