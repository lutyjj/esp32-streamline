"""Owner-only reads and atomic writes for private bridge state files."""

from __future__ import annotations

import contextlib
import os
import stat
import tempfile
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path


def write_private_file(path: Path, body: bytes) -> None:
    """Replace ``path`` with ``body`` durably, readable only by the bridge user."""
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=False) as target:
            target.write(body)
            target.flush()
            os.fsync(descriptor)
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
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


class PrivateFileError(ValueError):
    """A private state file the bridge must not trust."""


def read_private_file(path: Path, max_bytes: int) -> bytes | None:
    """Return the bytes of an owner-only regular file, or ``None`` when it is absent."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
            raise PrivateFileError("must be one regular file")
        if stat.S_IMODE(details.st_mode) != 0o600:
            raise PrivateFileError("permissions must be 0600")
        if details.st_uid != os.geteuid():
            raise PrivateFileError("must be owned by the bridge user")
        if details.st_size > max_bytes:
            raise PrivateFileError("exceeds its size limit")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            return source.read(max_bytes + 1)
    finally:
        os.close(descriptor)
