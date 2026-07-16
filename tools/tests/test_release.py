from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from streamline_tools.release import check_snapshot, check_versions, load_manifest, prepare_release


class PrepareReleaseTests(unittest.TestCase):
    def test_updates_every_checked_in_product_version(self) -> None:
        with ReleaseFixture() as root:
            prepare_release(root, "1.2.3")

            self.assertIn('version = "1.2.3"', (root / "bridge/pyproject.toml").read_text())
            self.assertIn('version = "1.2.3"', (root / "firmware/streamline/Cargo.toml").read_text())
            self.assertIn('version: "1.2.3"', (root / "ha-addon/config.yaml").read_text())
            self.assertIn(
                'name = "streamline-firmware"\nversion = "1.2.3"',
                (root / "firmware/streamline/Cargo.lock").read_text(),
            )

    def test_rejects_an_invalid_version_without_partial_writes(self) -> None:
        with ReleaseFixture() as root:
            before = {path: path.read_text() for path in root.rglob("*") if path.is_file()}

            with self.assertRaisesRegex(ValueError, "stable X.Y.Z"):
                prepare_release(root, "1.2.3-rc.1")

            self.assertEqual(before, {path: path.read_text() for path in before})

    def test_rejects_a_missing_version_without_partial_writes(self) -> None:
        with ReleaseFixture() as root:
            lock = root / "firmware/streamline/Cargo.lock"
            lock.write_text('[[package]]\nname = "another-package"\nversion = "0.5.2"\n')
            before = {path: path.read_text() for path in root.rglob("*") if path.is_file()}

            with self.assertRaisesRegex(ValueError, "Cargo.lock"):
                prepare_release(root, "1.2.3")

            self.assertEqual(before, {path: path.read_text() for path in before})

    def test_manifest_drives_additional_version_owners(self) -> None:
        with ReleaseFixture() as root:
            manifest_path = root / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["snapshot_paths"].append("new-component/project.toml")
            manifest["snapshot_paths"].sort()
            manifest["version_files"].append({"path": "new-component/project.toml", "format": "toml"})
            write(manifest_path, json.dumps(manifest))
            write(root / "new-component/project.toml", 'version = "0.5.2"\n')

            prepare_release(root, "1.2.3")

            self.assertEqual((root / "new-component/project.toml").read_text(), 'version = "1.2.3"\n')

    def test_version_validation_uses_every_manifest_owner(self) -> None:
        with ReleaseFixture() as root:
            manifest_path = root / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["snapshot_paths"].append("new-component/project.toml")
            manifest["snapshot_paths"].sort()
            manifest["version_files"].append({"path": "new-component/project.toml", "format": "toml"})
            write(manifest_path, json.dumps(manifest))
            write(root / "new-component/project.toml", 'version = "9.9.9"\n')

            with self.assertRaisesRegex(ValueError, "new-component/project.toml"):
                check_versions(root, "0.5.2")

    def test_rejects_duplicate_version_declarations_without_writes(self) -> None:
        with ReleaseFixture() as root:
            project = root / "bridge/pyproject.toml"
            project.write_text('version = "0.5.2"\nversion = "0.5.2"\n')
            before = {path: path.read_text() for path in root.rglob("*") if path.is_file()}

            with self.assertRaisesRegex(ValueError, "found 2"):
                prepare_release(root, "1.2.3")

            self.assertEqual(before, {path: path.read_text() for path in before})

    def test_snapshot_requires_the_exact_manifest_paths(self) -> None:
        with ReleaseFixture() as root:
            paths = [str(path) for path in load_manifest(root).snapshot_paths]

            check_snapshot(root, paths)
            with self.assertRaisesRegex(ValueError, "missing: ha-addon/CHANGELOG.md"):
                check_snapshot(root, paths[:-2] + paths[-1:])
            with self.assertRaisesRegex(ValueError, "unexpected: tools/release.py"):
                check_snapshot(root, [*paths, "tools/release.py"])

    def test_head_manifest_cannot_expand_the_base_allowlist(self) -> None:
        with ReleaseFixture() as base:
            paths = [str(path) for path in load_manifest(base).snapshot_paths]

            with self.assertRaisesRegex(ValueError, "release-manifest.json, tools/extra.py"):
                check_snapshot(base, [*paths, "release-manifest.json", "tools/extra.py"])

    def test_snapshot_compares_against_an_explicit_manifest(self) -> None:
        with ReleaseFixture() as root:
            manifest = json.loads((root / "release-manifest.json").read_text())
            manifest["snapshot_paths"] = sorted([*manifest["snapshot_paths"], "tools/extra.py"])
            base_manifest = root / "base-manifest.json"
            write(base_manifest, json.dumps(manifest))
            write(root / "tools/extra.py", "\n")
            paths = [str(path) for path in load_manifest(root, base_manifest).snapshot_paths]

            check_snapshot(root, paths, base_manifest)
            with self.assertRaisesRegex(ValueError, "unexpected: tools/extra.py"):
                check_snapshot(root, paths)

    def test_manifest_rejects_paths_outside_the_repository(self) -> None:
        with ReleaseFixture() as root:
            manifest_path = root / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["snapshot_paths"].append("../outside")
            write(manifest_path, json.dumps(manifest))

            with self.assertRaisesRegex(ValueError, "unsafe path"):
                load_manifest(root)

    def test_manifest_rejects_missing_snapshot_paths(self) -> None:
        with ReleaseFixture() as root:
            manifest_path = root / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["snapshot_paths"].append("missing/project.toml")
            manifest["snapshot_paths"].sort()
            write(manifest_path, json.dumps(manifest))

            with self.assertRaisesRegex(ValueError, "snapshot paths do not exist"):
                load_manifest(root)


class ReleaseFixture:
    _directory: TemporaryDirectory[str]

    def __enter__(self) -> Path:
        self._directory = TemporaryDirectory()
        root = Path(self._directory.name)
        write(root / "bridge/pyproject.toml", 'version = "0.5.2"\n')
        write(root / "firmware/streamline/Cargo.toml", 'version = "0.5.2"\n')
        write(root / "ha-addon/config.yaml", 'version: "0.5.2"\n')
        write(root / "firmware/streamline/Cargo.lock", '[[package]]\nname = "streamline-firmware"\nversion = "0.5.2"\n')
        write(root / "bridge/uv.lock", "lock\n")
        write(root / "ha-addon/CHANGELOG.md", "changelog\n")
        write(
            root / "release-manifest.json",
            json.dumps(
                {
                    "schema_version": 1,
                    "snapshot_paths": [
                        "bridge/pyproject.toml",
                        "bridge/uv.lock",
                        "firmware/streamline/Cargo.lock",
                        "firmware/streamline/Cargo.toml",
                        "ha-addon/CHANGELOG.md",
                        "ha-addon/config.yaml",
                    ],
                    "version_files": [
                        {"path": "bridge/pyproject.toml", "format": "toml"},
                        {"path": "firmware/streamline/Cargo.lock", "format": "cargo-lock"},
                        {"path": "firmware/streamline/Cargo.toml", "format": "toml"},
                        {"path": "ha-addon/config.yaml", "format": "yaml"},
                    ],
                }
            ),
        )
        return root

    def __exit__(self, *_: object) -> None:
        self._directory.cleanup()


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
