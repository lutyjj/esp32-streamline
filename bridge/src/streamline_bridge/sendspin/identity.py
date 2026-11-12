"""Persist one Sendspin client identity and pairing store per StreamLine source."""

from __future__ import annotations

from typing import TYPE_CHECKING

from aiosendspin.noise.keys import X25519_KEY_SIZE, Identity
from aiosendspin.noise.trust_store import FileClientPairingStore

from streamline_bridge.private_file import PrivateFileError, read_private_file, write_private_file
from streamline_bridge.source_identity import parse_source_identity

if TYPE_CHECKING:
    from pathlib import Path

IDENTITY_FILE = "identity.key"
PAIRING_FILE = "pairing.json"


class SendspinStateError(ValueError):
    """Stored Sendspin client state the bridge cannot use."""


class SendspinIdentityStore:
    """Own ``<directory>/<source>/`` for each published source.

    A source keeps its Sendspin client id across bridge restarts, so Music
    Assistant recognizes it and its pairing survives.
    """

    def __init__(self, directory: Path) -> None:
        self._directory = directory

    def identity(self, source: str) -> Identity:
        """Return the source's client identity, creating it on first use."""
        path = self._source_directory(source) / IDENTITY_FILE
        try:
            stored = read_private_file(path, X25519_KEY_SIZE)
        except PrivateFileError as exc:
            raise SendspinStateError(f"{path} {exc}") from exc
        if stored is None:
            identity = Identity.generate()
            write_private_file(path, identity.private_bytes)
            return identity
        try:
            return Identity.from_private_bytes(stored)
        except ValueError as exc:
            raise SendspinStateError(f"{path} does not hold an X25519 private key") from exc

    async def pairing_store(self, source: str) -> FileClientPairingStore:
        """Open the source's pairing store, creating an empty one on first use."""
        path = self._source_directory(source) / PAIRING_FILE
        try:
            return await FileClientPairingStore.open(path)
        except (TypeError, ValueError, KeyError) as exc:
            raise SendspinStateError(f"{path} is not a valid Sendspin pairing store: {exc}") from exc

    def _source_directory(self, source: str) -> Path:
        return self._directory / parse_source_identity(source)
