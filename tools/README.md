# Tools

Host-side developer utilities, packaged as one project (`streamline-tools`).
Nothing here ships to users or runs on the device. The layout mirrors
`bridge/`: one `pyproject.toml`, one `Dockerfile`, one `Makefile` with the
standard verbs (`format`, `lint`, `image`) plus run targets.

- `streamline-analyze` (`make tools-analyze REF=ref.flac CAP=capture.wav`) —
  compares a captured stream against its reference audio and reports offset,
  drift, and quality metrics.
- `streamline-capture` — bounded, non-interactive serial capture. Stdlib-only
  so `make firmware-capture` can run it with the system `python3`; the serial
  port is a host resource containers cannot reach.

Add a tool as a module in `src/streamline_tools/` with a console entry point in
`pyproject.toml` and, if it needs one, a run target in the Makefile.
