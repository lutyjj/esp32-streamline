"""Prepare the files that define one StreamLine product release."""

from __future__ import annotations

import argparse
import re
from collections.abc import Sequence
from pathlib import Path

RELEASE_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
FIRMWARE_LOCK_VERSION = re.compile(r'(\[\[package\]\]\nname = "streamline-firmware"\nversion = ")[^"]+(")')
VERSION_FILES = (
    (Path("bridge/pyproject.toml"), re.compile(r'(?m)^version = "[^"]+"$')),
    (Path("firmware/streamline/Cargo.toml"), re.compile(r'(?m)^version = "[^"]+"$')),
    (Path("ha-addon/config.yaml"), re.compile(r'(?m)^version: "[^"]+"$')),
    (Path("custom_components/streamline/manifest.json"), re.compile(r'(?m)^  "version": "[^"]+"$')),
    (Path("firmware/streamline/Cargo.lock"), FIRMWARE_LOCK_VERSION),
)


def prepare_release(root: Path, version: str) -> None:
    """Replace every checked-in product version as one release snapshot."""
    if not RELEASE_VERSION.fullmatch(version):
        msg = f"{version!r} is not a stable X.Y.Z release version"
        raise ValueError(msg)

    updated: dict[Path, str] = {}
    for relative_path, pattern in VERSION_FILES:
        path = root / relative_path
        source = path.read_text()
        replacement = _replacement(relative_path, version)
        result, replacements = pattern.subn(replacement, source, count=1)
        if replacements != 1:
            msg = f"expected one version in {relative_path}, found {replacements}"
            raise ValueError(msg)
        updated[path] = result

    for path, content in updated.items():
        path.write_text(content)


def _replacement(relative_path: Path, version: str) -> str:
    if relative_path == Path("firmware/streamline/Cargo.lock"):
        return rf"\g<1>{version}\g<2>"
    if relative_path == Path("ha-addon/config.yaml"):
        return f'version: "{version}"'
    if relative_path == Path("custom_components/streamline/manifest.json"):
        return f'  "version": "{version}"'
    return f'version = "{version}"'


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--version", required=True)
    args = parser.parse_args(argv)

    try:
        prepare_release(args.root, args.version)
    except ValueError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
