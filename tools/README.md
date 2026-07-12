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
- `streamline-smoke` — boot and API sanity checks for one device.
  `make tools-smoke-qemu` boots the merged flash image
  (`make -C firmware artifacts VERSION=dev`) in Espressif's QEMU inside a
  container and verifies the transcript up to the emulation frontier: QEMU has
  no Wi-Fi PHY, so a boot is provable up to board-descriptor resolution.
  `make tools-smoke-device` resets the USB-connected board, verifies the same
  transcript through Wi-Fi mode resolution, then checks the read-only HTTP
  API; it runs stdlib-only on the host `python3` because the serial port and
  the LAN device are host resources. Pass `--json` for a machine-readable
  report.

Add a tool as a module in `src/streamline_tools/` with a console entry point in
`pyproject.toml` and, if it needs one, a run target in the Makefile.
