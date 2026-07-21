"""Bounded one-shot secret input for local container tools."""

from __future__ import annotations

import os
from collections.abc import MutableMapping

DEFAULT_SECRET_LIMIT = 4096


def read_secret_fd(
    environment: MutableMapping[str, str],
    variable: str,
    *,
    limit: int = DEFAULT_SECRET_LIMIT,
) -> str:
    """Consume a UTF-8 secret from the descriptor named by ``variable``.

    The descriptor number is removed from the environment before reading. The
    caller owns the original descriptor; this function closes only its duplicate.
    Empty or absent input means that the optional secret is unavailable.
    """

    descriptor_text = environment.pop(variable, None)
    if descriptor_text is None:
        return ""
    try:
        descriptor = int(descriptor_text)
    except ValueError:
        raise ValueError(f"{variable} must name a file descriptor") from None
    if descriptor < 0:
        raise ValueError(f"{variable} must name a non-negative file descriptor")
    try:
        duplicate = os.dup(descriptor)
    except OSError:
        raise ValueError(f"{variable} names an unreadable file descriptor") from None
    with os.fdopen(duplicate, "rb") as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ValueError(f"secret input exceeds {limit} bytes")
    try:
        return value.rstrip(b"\r\n").decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("secret input must be UTF-8") from None
