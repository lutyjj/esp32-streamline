from __future__ import annotations

import os
import re
import unittest
from pathlib import Path
from typing import ClassVar

MANIFEST_ECOSYSTEMS = {
    "Cargo.toml": "cargo",
    "package.json": "npm",
    "uv.lock": "uv",
}
MANAGED_ECOSYSTEMS = {*MANIFEST_ECOSYSTEMS.values(), "docker", "github-actions"}
IGNORED_DIRECTORIES = {".cache", ".embuild", ".git", ".vite", "dist", "node_modules", "target"}
PINNED_IMAGE = re.compile(r"[^@\s]+:[^@\s]+@sha256:[0-9a-f]{64}")
PINNED_ACTION = re.compile(r"[0-9a-f]{40}")
VERSION_COMMENT = re.compile(r"v[0-9]+(?:\.[0-9]+){0,2}")


class DependencyManagementTests(unittest.TestCase):
    root: ClassVar[Path]

    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(os.environ["STREAMLINE_REPO_ROOT"])

    def test_dependabot_owns_every_supported_dependency_manifest(self) -> None:
        expected = {("github-actions", "/")}
        for filename, ecosystem in MANIFEST_ECOSYSTEMS.items():
            expected.update(
                (ecosystem, repository_directory(self.root, path)) for path in source_files(self.root, filename)
            )
        expected.update(
            ("docker", repository_directory(self.root, path)) for path in source_files(self.root, "Dockerfile*")
        )

        configured = {
            entry
            for entry in dependabot_entries((self.root / ".github/dependabot.yml").read_text())
            if entry[0] in MANAGED_ECOSYSTEMS
        }

        self.assertSetEqual(expected, configured)

    def test_every_external_docker_base_has_a_tag_and_digest(self) -> None:
        failures: list[str] = []
        for dockerfile in source_files(self.root, "Dockerfile*"):
            stages: set[str] = set()
            for line_number, line in enumerate(dockerfile.read_text().splitlines(), start=1):
                tokens = line.split()
                if not tokens or tokens[0].upper() != "FROM":
                    continue
                image = next(token for token in tokens[1:] if not token.startswith("--"))
                if image not in stages and image != "scratch" and not PINNED_IMAGE.fullmatch(image):
                    failures.append(f"{dockerfile.relative_to(self.root)}:{line_number}: {image}")
                lowered = [token.lower() for token in tokens]
                if "as" in lowered:
                    stages.add(tokens[lowered.index("as") + 1])

        self.assertFalse(failures, "Unpinned Docker bases:\n" + "\n".join(failures))

    def test_every_external_action_has_a_sha_and_version_comment(self) -> None:
        failures: list[str] = []
        uses = re.compile(r"^\s*-\s+uses:\s+([^\s#]+)(?:\s+#\s+(\S+))?\s*$")
        workflow_files = (
            *source_files(self.root / ".github/workflows", "*.yml"),
            *source_files(self.root / ".github/workflows", "*.yaml"),
        )
        for workflow in workflow_files:
            for line_number, line in enumerate(workflow.read_text().splitlines(), start=1):
                match = uses.match(line)
                if match is None or match.group(1).startswith("./"):
                    continue
                action, separator, revision = match.group(1).rpartition("@")
                version = match.group(2)
                if not action or not separator or not PINNED_ACTION.fullmatch(revision):
                    failures.append(f"{workflow.relative_to(self.root)}:{line_number}: {match.group(1)}")
                elif version is None or not VERSION_COMMENT.fullmatch(version):
                    failures.append(f"{workflow.relative_to(self.root)}:{line_number}: missing version comment")

        self.assertFalse(failures, "Unmanaged GitHub Actions:\n" + "\n".join(failures))


def dependabot_entries(source: str) -> set[tuple[str, str]]:
    entries: set[tuple[str, str]] = set()
    blocks = re.finditer(
        r"(?ms)^  - package-ecosystem:\s*([^\s#]+)(.*?)(?=^  - package-ecosystem:|\Z)",
        source,
    )
    for block in blocks:
        directory = re.search(r"(?m)^    directory:\s*([^\s#]+)", block.group(2))
        if directory is not None:
            entries.add((unquote(block.group(1)), unquote(directory.group(1))))
    return entries


def source_files(root: Path, pattern: str) -> tuple[Path, ...]:
    return tuple(
        path
        for path in root.rglob(pattern)
        if path.is_file() and not IGNORED_DIRECTORIES.intersection(path.relative_to(root).parts)
    )


def repository_directory(root: Path, path: Path) -> str:
    relative = path.parent.relative_to(root)
    return "/" if relative == Path(".") else f"/{relative.as_posix()}"


def unquote(value: str) -> str:
    return value.strip("'\"")
