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
- `streamline-smoke` — serial boot sanity for the USB-connected board:
  `make tools-smoke-device` resets it and verifies the boot transcript
  through Wi-Fi mode resolution, stdlib-only on the host `python3` because
  the serial port is a host resource. Pass `--json` for a machine-readable
  report.
- `smoke/` — the device smoke suite (pytest + pytest-embedded), written
  against the device API so the same tests run on both targets.
  `make tools-smoke-qemu` boots the QEMU image variant
  (`make -C firmware qemu-artifacts`) per test and runs everything;
  `make tools-smoke-device` runs the same suite against the real board's
  URL after the serial check, where tests marked `emulated` (fresh-flash
  boots, the commissioning-persistence cycle) skip with a reason. QEMU
  emulates no Wi-Fi PHY or audio, and a warm restart is out of contract
  (the emulated NIC survives a soft reset), so each emulated boot is one
  QEMU process; Wi-Fi, I2S capture, and the codec remain hardware-only
  surfaces.

Add a tool as a module in `src/streamline_tools/` with a console entry point in
`pyproject.toml` and, if it needs one, a run target in the Makefile.
