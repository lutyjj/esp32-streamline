from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from streamline_tools.release import prepare_release


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


class ReleaseFixture:
    _directory: TemporaryDirectory[str]

    def __enter__(self) -> Path:
        self._directory = TemporaryDirectory()
        root = Path(self._directory.name)
        write(root / "bridge/pyproject.toml", 'version = "0.5.2"\n')
        write(root / "firmware/streamline/Cargo.toml", 'version = "0.5.2"\n')
        write(root / "ha-addon/config.yaml", 'version: "0.5.2"\n')
        write(root / "firmware/streamline/Cargo.lock", '[[package]]\nname = "streamline-firmware"\nversion = "0.5.2"\n')
        return root

    def __exit__(self, *_: object) -> None:
        self._directory.cleanup()


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
