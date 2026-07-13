"""TLS 1.3 PSK authentication and bounded persistent device-key storage."""

from __future__ import annotations

import contextlib
import hmac
import json
import os
import re
import ssl
import stat
import tempfile
import threading
from typing import TYPE_CHECKING, Final

from streamline_bridge.tcp import AuthenticatedConnection

if TYPE_CHECKING:
    import socket
    from pathlib import Path

CONTRACT_VERSION: Final = 1
DEFAULT_CLEARTEXT_PORT: Final = 39000
DEFAULT_TLS_PORT: Final = 39001
KEY_ID_PATTERN_TEXT: Final = r"^eli1-[0-9a-f]{32}$"
KEY_ID_PATTERN = re.compile(KEY_ID_PATTERN_TEXT)
PSK_PATTERN = re.compile(r"^[0-9a-f]{64}$")
PSK_BYTES: Final = 32
MAX_KEYS: Final = 64
MAX_KEY_FILE_BYTES: Final = 16 * 1024
TLS_CIPHER: Final = "TLS_AES_128_GCM_SHA256"
TLS_IDENTITY_PREFIX: Final = f"eli1:{CONTRACT_VERSION}:"
TLS_VERSION: Final = "TLSv1.3"
TLS_KEY_EXCHANGE: Final = "psk_dhe_ke"


class TransportKeyError(ValueError):
    """Invalid key input or key-store state."""


class TransportKeyStore:
    """Thread-safe versioned key map with atomic replace-on-write persistence."""

    def __init__(self, path: Path, maximum: int = MAX_KEYS) -> None:
        if maximum < 1 or maximum > MAX_KEYS:
            raise ValueError(f"transport key limit must be between 1 and {MAX_KEYS}")
        self._path = path
        self._maximum = maximum
        self._lock = threading.RLock()
        self._keys = self._load()

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
            raise TransportKeyError("PSK must be exactly 64 lowercase hexadecimal characters")
        with self._lock:
            if key_id not in self._keys and len(self._keys) >= self._maximum:
                raise TransportKeyError(f"transport key limit reached ({self._maximum})")
            next_keys = {**self._keys, key_id: psk}
            self._write(next_keys)
            self._keys = next_keys

    def delete(self, key_id: str) -> None:
        validate_key_id(key_id)
        with self._lock:
            if key_id not in self._keys:
                raise TransportKeyError("unknown transport key id")
            next_keys = dict(self._keys)
            del next_keys[key_id]
            self._write(next_keys)
            self._keys = next_keys

    def _load(self) -> dict[str, str]:
        try:
            descriptor = os.open(self._path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return {}
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
                raise TransportKeyError("transport key file must be one regular file")
            if details.st_size > MAX_KEY_FILE_BYTES:
                raise TransportKeyError("transport key file exceeds its size limit")
            with os.fdopen(descriptor, "rb", closefd=False) as source:
                raw = source.read(MAX_KEY_FILE_BYTES + 1)
        finally:
            os.close(descriptor)
        try:
            document = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TransportKeyError("transport key file is not valid JSON") from exc
        if not isinstance(document, dict) or set(document) != {"version", "keys"} or document["version"] != 1:
            raise TransportKeyError("unsupported transport key file contract")
        keys = document["keys"]
        if not isinstance(keys, dict) or len(keys) > self._maximum:
            raise TransportKeyError("transport key file exceeds its key limit")
        validated: dict[str, str] = {}
        for key_id, psk in keys.items():
            if not isinstance(key_id, str) or not isinstance(psk, str):
                raise TransportKeyError("transport key entries must be strings")
            validate_key_id(key_id)
            if not PSK_PATTERN.fullmatch(psk):
                raise TransportKeyError("transport key file contains an invalid PSK")
            validated[key_id] = psk
        return validated

    def _write(self, keys: dict[str, str]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        body = json.dumps({"version": 1, "keys": keys}, separators=(",", ":"), sort_keys=True).encode()
        if len(body) > MAX_KEY_FILE_BYTES:
            raise TransportKeyError("transport key file exceeds its size limit")
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

    def __init__(self, keys: TransportKeyStore) -> None:
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
    """Bridge HTTP-facing transport configuration and key mutation boundary."""

    def __init__(
        self,
        keys: TransportKeyStore | None,
        authenticator: TlsPskAuthenticator | None,
        token: str | None,
        *,
        cleartext_enabled: bool,
        tls_enabled: bool,
        cleartext_port: int,
        tls_port: int,
    ) -> None:
        self.keys = keys
        self.authenticator = authenticator
        self._token = token
        self._cleartext_enabled = cleartext_enabled
        self._tls_enabled = tls_enabled
        self._cleartext_port = cleartext_port
        self._tls_port = tls_port

    def authorize(self, candidate: str) -> bool:
        return self._token is not None and hmac.compare_digest(candidate, self._token)

    def snapshot(self) -> dict[str, object]:
        successes, failures = self.authenticator.snapshot() if self.authenticator is not None else (0, 0)
        return {
            "contract_version": CONTRACT_VERSION,
            "cleartext_enabled": self._cleartext_enabled,
            "tls_enabled": self._tls_enabled,
            "cleartext_port": self._cleartext_port,
            "tls_port": self._tls_port,
            "key_ids": list(self.keys.ids()) if self.keys is not None else [],
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
        raise TransportKeyError("invalid transport key id")
