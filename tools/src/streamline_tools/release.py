"""Prepare and validate one StreamLine release snapshot."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

RELEASE_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
VERSION_PATTERNS = {
    "cargo-lock": re.compile(
        r'(?P<prefix>\[\[package\]\]\nname = "streamline-firmware"\nversion = ")(?P<version>[^"]+)(?P<suffix>")'
    ),
    "toml": re.compile(r'(?m)^(?P<prefix>version = ")(?P<version>[^"]+)(?P<suffix>")$'),
    "yaml": re.compile(r'(?m)^(?P<prefix>version: ")(?P<version>[^"]+)(?P<suffix>")$'),
}
MANIFEST_PATH = Path("release-manifest.json")
VERSION_FORMATS = frozenset(VERSION_PATTERNS)


@dataclass(frozen=True)
class VersionFile:
    path: Path
    format: str


@dataclass(frozen=True)
class ReleaseManifest:
    snapshot_paths: tuple[Path, ...]
    version_files: tuple[VersionFile, ...]


def load_manifest(root: Path, manifest_path: Path | None = None) -> ReleaseManifest:
    """Load the release file contract and reject ambiguous paths or owners.

    CI and promotion pass the pull request's base-commit manifest through
    `manifest_path` so a release PR cannot expand its own allowlist; snapshot
    paths are still required to exist under `root`.
    """
    try:
        document: Any = json.loads((manifest_path or root / MANIFEST_PATH).read_text())
    except (OSError, json.JSONDecodeError) as error:
        msg = f"cannot read {MANIFEST_PATH}: {error}"
        raise ValueError(msg) from error
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        msg = f"{MANIFEST_PATH} must use schema_version 1"
        raise ValueError(msg)

    snapshot_paths = _paths(document.get("snapshot_paths"), "snapshot_paths")
    raw_version_files = document.get("version_files")
    if not isinstance(raw_version_files, list) or not raw_version_files:
        msg = f"{MANIFEST_PATH} version_files must be a non-empty list"
        raise ValueError(msg)

    version_files: list[VersionFile] = []
    for index, value in enumerate(raw_version_files):
        if not isinstance(value, dict):
            msg = f"{MANIFEST_PATH} version_files[{index}] must be an object"
            raise ValueError(msg)
        path = _path(value.get("path"), f"version_files[{index}].path")
        format_name = value.get("format")
        if format_name not in VERSION_FORMATS:
            msg = f"{MANIFEST_PATH} has unsupported version format {format_name!r} for {path}"
            raise ValueError(msg)
        version_files.append(VersionFile(path=path, format=format_name))

    version_paths = tuple(owner.path for owner in version_files)
    if len(version_paths) != len(set(version_paths)):
        msg = f"{MANIFEST_PATH} version_files contains duplicate paths"
        raise ValueError(msg)
    if version_paths != tuple(sorted(version_paths)):
        msg = f"{MANIFEST_PATH} version_files must be sorted by path"
        raise ValueError(msg)
    missing = sorted(set(version_paths) - set(snapshot_paths))
    if missing:
        msg = f"{MANIFEST_PATH} version files missing from snapshot_paths: {_names(missing)}"
        raise ValueError(msg)
    absent = tuple(path for path in snapshot_paths if not (root / path).is_file())
    if absent:
        msg = f"{MANIFEST_PATH} snapshot paths do not exist: {_names(absent)}"
        raise ValueError(msg)
    return ReleaseManifest(snapshot_paths=snapshot_paths, version_files=tuple(version_files))


def prepare_release(root: Path, version: str) -> None:
    """Replace every checked-in product version as one release snapshot."""
    if not RELEASE_VERSION.fullmatch(version):
        msg = f"{version!r} is not a stable X.Y.Z release version"
        raise ValueError(msg)

    manifest = load_manifest(root)
    updated: dict[Path, str] = {}
    for owner in manifest.version_files:
        path = root / owner.path
        source = path.read_text()
        pattern = VERSION_PATTERNS[owner.format]
        matches = tuple(pattern.finditer(source))
        if len(matches) != 1:
            msg = f"expected one version in {owner.path}, found {len(matches)}"
            raise ValueError(msg)
        result = pattern.sub(rf"\g<prefix>{version}\g<suffix>", source)
        updated[path] = result

    for path, content in updated.items():
        path.write_text(content)


def check_versions(root: Path, expected: str) -> None:
    """Require every manifest version owner to contain the expected version."""
    if not RELEASE_VERSION.fullmatch(expected):
        msg = f"{expected!r} is not a stable X.Y.Z release version"
        raise ValueError(msg)
    for owner in load_manifest(root).version_files:
        path = root / owner.path
        matches = tuple(VERSION_PATTERNS[owner.format].finditer(path.read_text()))
        if len(matches) != 1:
            msg = f"expected one version in {owner.path}, found {len(matches)}"
            raise ValueError(msg)
        actual = matches[0].group("version")
        if actual != expected:
            msg = f"expected {owner.path} to contain version {expected}, found {actual}"
            raise ValueError(msg)


def check_snapshot(root: Path, changed_paths: Iterable[str], manifest_path: Path | None = None) -> None:
    """Require the changed path set to match the release manifest exactly."""
    expected = set(load_manifest(root, manifest_path).snapshot_paths)
    actual = {Path(value.strip()) for value in changed_paths if value.strip()}
    missing = sorted(expected - actual)
    unexpected = sorted(actual - expected)
    if not missing and not unexpected:
        return
    details = []
    if missing:
        details.append(f"missing: {_names(missing)}")
    if unexpected:
        details.append(f"unexpected: {_names(unexpected)}")
    msg = f"release snapshot does not match {MANIFEST_PATH} ({'; '.join(details)})"
    raise ValueError(msg)


def _paths(value: object, field: str) -> tuple[Path, ...]:
    if not isinstance(value, list) or not value:
        msg = f"{MANIFEST_PATH} {field} must be a non-empty list"
        raise ValueError(msg)
    paths = tuple(_path(item, field) for item in value)
    if len(paths) != len(set(paths)):
        msg = f"{MANIFEST_PATH} {field} contains duplicate paths"
        raise ValueError(msg)
    if paths != tuple(sorted(paths)):
        msg = f"{MANIFEST_PATH} {field} must be sorted"
        raise ValueError(msg)
    return paths


def _path(value: object, field: str) -> Path:
    if not isinstance(value, str) or not value:
        msg = f"{MANIFEST_PATH} {field} must contain repository-relative paths"
        raise ValueError(msg)
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path == Path("."):
        msg = f"{MANIFEST_PATH} {field} contains unsafe path {value!r}"
        raise ValueError(msg)
    return path


def _names(paths: Sequence[Path]) -> str:
    return ", ".join(str(path) for path in paths)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare", help="update every version owner")
    prepare.add_argument("--root", type=Path, default=Path.cwd())
    prepare.add_argument("--version", required=True)
    snapshot = commands.add_parser("check-snapshot", help="validate changed paths from stdin")
    snapshot.add_argument("--root", type=Path, default=Path.cwd())
    snapshot.add_argument("--manifest", type=Path, default=None, help="manifest to compare against")
    versions = commands.add_parser("check-versions", help="validate every version owner")
    versions.add_argument("--root", type=Path, default=Path.cwd())
    versions.add_argument("--version", required=True)
    args = parser.parse_args(argv)

    try:
        if args.command == "prepare":
            prepare_release(args.root, args.version)
        elif args.command == "check-versions":
            check_versions(args.root, args.version)
        else:
            check_snapshot(args.root, sys.stdin, args.manifest)
    except ValueError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
