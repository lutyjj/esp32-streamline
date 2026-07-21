"""TLS 1.3 PSK authentication and persistent transport state (mode + keys)."""

from __future__ import annotations

import contextlib
import json
import os
import re
import ssl
import stat
import tempfile
import threading
from typing import TYPE_CHECKING, Final

from streamline_bridge.source_identity import TRANSPORT_KEY_ID_PATTERN, TRANSPORT_KEY_ID_PATTERN_TEXT
from streamline_bridge.tcp import AuthenticatedConnection, CleartextAuthenticator

if TYPE_CHECKING:
    import socket
    from collections.abc import Callable
    from pathlib import Path

    from streamline_bridge.tcp import ConnectionAuthenticator

CONTRACT_VERSION: Final = 1
DEFAULT_PORT: Final = 39000
KEY_ID_PATTERN_TEXT: Final = TRANSPORT_KEY_ID_PATTERN_TEXT
KEY_ID_PATTERN = TRANSPORT_KEY_ID_PATTERN
PSK_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PSK_BYTES: Final = 32
MAX_KEYS: Final = 64
MAX_STATE_FILE_BYTES: Final = 16 * 1024
TLS_CIPHER: Final = "TLS_AES_128_GCM_SHA256"
TLS_IDENTITY_PREFIX: Final = f"eli1:{CONTRACT_VERSION}:"
TLS_VERSION: Final = "TLSv1.3"
TLS_KEY_EXCHANGE: Final = "psk_dhe_ke"


class TransportStateError(ValueError):
    """Invalid transport state input or stored state."""


class TransportStateStore:
    """Thread-safe versioned transport state with atomic replace-on-write persistence.

    One private file owns the listener mode and the bounded device-key map, so
    a mode change and its key set survive a bridge restart together.
    """

    def __init__(self, path: Path, maximum: int = MAX_KEYS) -> None:
        if maximum < 1 or maximum > MAX_KEYS:
            raise ValueError(f"transport key limit must be between 1 and {MAX_KEYS}")
        self._path = path
        self._maximum = maximum
        self._lock = threading.RLock()
        self._keys, self._tls_enabled = self._load()

    @property
    def tls_enabled(self) -> bool:
        with self._lock:
            return self._tls_enabled

    def set_tls_enabled(self, enabled: bool) -> None:
        with self._lock:
            if self._tls_enabled == enabled:
                return
            self._write(self._keys, enabled)
            self._tls_enabled = enabled

    def get(self, key_id: str) -> bytes | None:
        with self._lock:
            value = self._keys.get(key_id)
            return bytes.fromhex(value) if value is not None else None

    def ids(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(sorted(self._keys))

    def put(self, key_id: str, psk: str) -> None:
        validate_key_id(key_id)
        if not PSK_PATTERN.fullmatch(psk):
            raise TransportStateError("PSK must be exactly 64 lowercase hexadecimal characters")
        with self._lock:
            if key_id not in self._keys and len(self._keys) >= self._maximum:
                raise TransportStateError(f"transport key limit reached ({self._maximum})")
            next_keys = {**self._keys, key_id: psk}
            self._write(next_keys, self._tls_enabled)
            self._keys = next_keys

    def delete(self, key_id: str) -> None:
        validate_key_id(key_id)
        with self._lock:
            if key_id not in self._keys:
                raise TransportStateError("unknown transport key id")
            next_keys = dict(self._keys)
            del next_keys[key_id]
            self._write(next_keys, self._tls_enabled)
            self._keys = next_keys

    def _load(self) -> tuple[dict[str, str], bool]:
        try:
            descriptor = os.open(self._path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {}, False
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
                raise TransportStateError("transport state file must be one regular file")
            if details.st_size > MAX_STATE_FILE_BYTES:
                raise TransportStateError("transport state file exceeds its size limit")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                raw = source.read(MAX_STATE_FILE_BYTES + 1)
        finally:
            os.close(descriptor)
        try:
            document = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TransportStateError("transport state file is not valid JSON") from exc
        if (
            not isinstance(document, dict)
            or set(document) != {"version", "tls_enabled", "keys"}
            or document["version"] != 1
        ):
            raise TransportStateError("unsupported transport state file contract")
        tls_enabled = document["tls_enabled"]
        if not isinstance(tls_enabled, bool):
            raise TransportStateError("transport state tls_enabled must be a boolean")
        keys = document["keys"]
        if not isinstance(keys, dict) or len(keys) > self._maximum:
            raise TransportStateError("transport state file exceeds its key limit")
        validated: dict[str, str] = {}
        for key_id, psk in keys.items():
            if not isinstance(key_id, str) or not isinstance(psk, str):
                raise TransportStateError("transport key entries must be strings")
            validate_key_id(key_id)
            if not PSK_PATTERN.fullmatch(psk):
                raise TransportStateError("transport state file contains an invalid PSK")
            validated[key_id] = psk
        return validated, tls_enabled

    def _write(self, keys: dict[str, str], tls_enabled: bool) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body = json.dumps(
            {"version": 1, "tls_enabled": tls_enabled, "keys": keys}, separators=(",", ":"), sort_keys=True
        ).encode()
        if len(body) > MAX_STATE_FILE_BYTES:
            raise TransportStateError("transport state file exceeds its size limit")
        descriptor, temporary = tempfile.mkstemp(prefix=f".{self._path.name}.", dir=self._path.parent)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=False) as target:
                target.write(body)
                target.flush()
                os.fsync(descriptor)
            os.replace(temporary, self._path)
            directory = os.open(self._path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(temporary)
            raise
        finally:
            os.close(descriptor)


class TlsPskAuthenticator:
    """Authenticate one producer before the source registry can observe it."""

    def __init__(self, keys: TransportStateStore) -> None:
        self._keys = keys
        self._local = threading.local()
        self._lock = threading.Lock()
        self._successes = 0
        self._failures = 0
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_3
        context.maximum_version = ssl.TLSVersion.TLSv1_3
        context.options |= ssl.OP_NO_TICKET
        context.num_tickets = 0
        context.set_psk_server_callback(self._lookup_psk)
        self._context = context

    def authenticate(self, conn: socket.socket, _addr: tuple[str, int]) -> AuthenticatedConnection:
        self._local.key_id = None
        try:
            stream = self._context.wrap_socket(conn, server_side=True)
            key_id: str | None = self._local.key_id
            cipher = stream.cipher()
            if key_id is None or stream.version() != "TLSv1.3" or cipher is None or cipher[0] != TLS_CIPHER:
                stream.close()
                raise ValueError("producer did not negotiate the required TLS profile")
        except (OSError, ssl.SSLError, ValueError):
            self._record(False)
            raise
        self._record(True)
        return AuthenticatedConnection(stream, key_id, "tls-psk")

    def snapshot(self) -> tuple[int, int]:
        with self._lock:
            return self._successes, self._failures

    def _lookup_psk(self, identity: str | None) -> bytes:
        key_id = parse_identity(identity)
        key = self._keys.get(key_id) if key_id is not None else None
        if key is None:
            self._local.key_id = None
            return b""
        self._local.key_id = key_id
        return key

    def _record(self, success: bool) -> None:
        with self._lock:
            if success:
                self._successes += 1
            else:
                self._failures += 1


class TransportControl:
    """Transport policy boundary between the PCM listener and the HTTP adapter.

    The PCM listener asks it for the authenticator matching the current mode;
    the HTTP adapter drives mode and key mutations through it. Every mutation
    persists first, then disconnects the producers it invalidates: a mode
    change drops all of them so exactly one protocol is ever admitted, and a
    key replacement or deletion drops only that key's live TLS sessions.
    """

    def __init__(
        self,
        store: TransportStateStore | None,
        authenticator: TlsPskAuthenticator | None,
        *,
        port: int,
    ) -> None:
        self.store = store
        self.authenticator = authenticator
        self._cleartext = CleartextAuthenticator()
        self._port = port
        self._disconnect_producers: Callable[[str | None], None] = lambda _source_key: None

    @property
    def configurable(self) -> bool:
        return self.store is not None and self.authenticator is not None

    @property
    def tls_enabled(self) -> bool:
        return self.store is not None and self.store.tls_enabled

    def producer_authenticator(self) -> ConnectionAuthenticator:
        authenticator = self.authenticator
        if authenticator is not None and self.tls_enabled:
            return authenticator
        return self._cleartext

    def bind_producer_disconnect(self, disconnect: Callable[[str | None], None]) -> None:
        self._disconnect_producers = disconnect

    def set_tls_enabled(self, enabled: bool) -> None:
        if self.store is None:
            raise TransportStateError("transport state storage is not configured")
        if self.store.tls_enabled == enabled:
            return
        self.store.set_tls_enabled(enabled)
        self._disconnect_producers(None)

    def put_key(self, key_id: str, psk: str) -> None:
        """Provision or replace one key; a replacement revokes its sessions."""
        if self.store is None:
            raise TransportStateError("transport state storage is not configured")
        replacing = self.store.get(key_id) is not None
        self.store.put(key_id, psk)
        if replacing:
            self._disconnect_producers(key_id)

    def delete_key(self, key_id: str) -> None:
        """Remove one key, then close every session it authenticated."""
        if self.store is None:
            raise TransportStateError("transport state storage is not configured")
        self.store.delete(key_id)
        self._disconnect_producers(key_id)

    def snapshot(self) -> dict[str, object]:
        successes, failures = self.authenticator.snapshot() if self.authenticator is not None else (0, 0)
        return {
            "contract_version": CONTRACT_VERSION,
            "mode": "tls-psk" if self.tls_enabled else "cleartext",
            "configurable": self.configurable,
            "port": self._port,
            "key_ids": list(self.store.ids()) if self.store is not None else [],
            "auth_successes": successes,
            "auth_failures": failures,
        }


def parse_identity(identity: str | None) -> str | None:
    if identity is None or not identity.startswith(TLS_IDENTITY_PREFIX):
        return None
    key_id = identity.removeprefix(TLS_IDENTITY_PREFIX)
    return key_id if KEY_ID_PATTERN.fullmatch(key_id) else None


def validate_key_id(key_id: str) -> None:
    if not KEY_ID_PATTERN.fullmatch(key_id):
        raise TransportStateError("invalid transport key id")
