"""Generate the checked bridge OpenAPI artifact from the runtime app."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from streamline_bridge.http import make_app
from streamline_bridge.pipeline import AudioPipeline
from streamline_bridge.sources import SourceRegistry


def make_pipeline() -> AudioPipeline:
    return AudioPipeline(4, 0.001, 1, 1.0, start_worker=False)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m streamline_bridge.openapi <output.json>")
    app = make_app(SourceRegistry(make_pipeline, max_sources=1), "spec")
    output = json.dumps(app.openapi(), indent=2, sort_keys=True) + "\n"
    Path(sys.argv[1]).write_text(output, encoding="utf-8")


if __name__ == "__main__":
    main()
