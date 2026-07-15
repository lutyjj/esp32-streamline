from __future__ import annotations

import os
import re
import unittest
from collections.abc import Iterable
from pathlib import Path

import yaml

REPO_ROOT = Path(os.environ["STREAMLINE_REPO_ROOT"])
FILTERS_PATH = REPO_ROOT / ".github/ci-paths.yml"


class CiPathOwnershipTests(unittest.TestCase):
    def test_representative_paths_run_every_owner(self) -> None:
        cases = {
            "Makefile": ALL_FILTERS,
            "mk/common.mk": ALL_FILTERS,
            ".github/workflows/ci.yml": ALL_FILTERS,
            ".markdownlint.json": {"repository"},
            "lychee.toml": {"repository"},
            "SECURITY.md": {"repository"},
            "bridge/README.md": {"bridge", "console", "repository"},
            "firmware/streamline/README.md": {"firmware", "qemu_smoke", "repository"},
            "ha-addon/DOCS.md": {"ha-addon", "repository"},
            "tools/README.md": {"repository", "tools"},
            "docs/pcm-protocol.md": {"bridge", "firmware", "repository"},
            "docs/openapi.json": {"api_contract", "qemu_smoke", "repository"},
            "release-manifest.json": {"repository", "tools"},
            "tools/Dockerfile": {"qemu_smoke", "tools"},
            "tools/uv.lock": {"qemu_smoke", "tools"},
            "tools/smoke/test_api.py": {"qemu_smoke", "tools"},
            "tools/src/streamline_tools/device/api.py": {"qemu_smoke", "tools"},
            "tools/src/streamline_tools/smoke.py": {"qemu_smoke", "tools"},
            "tools/src/streamline_tools/analysis/report.py": {"tools"},
            "firmware/streamline/src/api.rs": {"firmware", "qemu_smoke"},
        }
        filters = load_filters()

        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(matching_filters(filters, path), expected)

    def test_ci_consumes_the_checked_path_matrix(self) -> None:
        workflow = (REPO_ROOT / ".github/workflows/ci.yml").read_text()

        self.assertIn("filters: .github/ci-paths.yml", workflow)


ALL_FILTERS = {
    "api_contract",
    "bridge",
    "console",
    "firmware",
    "ha-addon",
    "qemu_smoke",
    "repository",
    "tools",
    "webflasher",
}


def load_filters() -> dict[str, list[str]]:
    document = yaml.safe_load(FILTERS_PATH.read_text())
    if not isinstance(document, dict):
        raise TypeError(f"{FILTERS_PATH} must contain a mapping")
    return {str(name): list(flatten(patterns)) for name, patterns in document.items() if name != "shared"}


def flatten(values: object) -> Iterable[str]:
    if isinstance(values, str):
        yield values
        return
    if not isinstance(values, list):
        raise TypeError(f"path patterns must be strings or lists, got {type(values).__name__}")
    for value in values:
        yield from flatten(value)


def matching_filters(filters: dict[str, list[str]], path: str) -> set[str]:
    return {name for name, patterns in filters.items() if any(glob_matches(path, pattern) for pattern in patterns)}


def glob_matches(path: str, pattern: str) -> bool:
    expression = ""
    index = 0
    while index < len(pattern):
        if pattern.startswith("**/", index):
            expression += "(?:.*/)?"
            index += 3
        elif pattern.startswith("**", index):
            expression += ".*"
            index += 2
        elif pattern[index] == "*":
            expression += "[^/]*"
            index += 1
        elif pattern[index] == "?":
            expression += "[^/]"
            index += 1
        else:
            expression += re.escape(pattern[index])
            index += 1
    return re.fullmatch(expression, path) is not None
