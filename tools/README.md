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
- `streamline-smoke` — boot and API sanity checks for the USB-connected
  board. `make tools-smoke-device` resets it, verifies the boot transcript
  through Wi-Fi mode resolution, then checks the read-only HTTP API; it runs
  stdlib-only on the host `python3` because the serial port and the LAN
  device are host resources. Pass `--json` for a machine-readable report.
- `smoke/` — the emulated-device pytest suite (pytest-embedded).
  `make tools-smoke-qemu` boots the QEMU image variant
  (`make -C firmware qemu-artifacts`) in Espressif's QEMU inside a container
  and proves boot, the HTTP API over the emulated network, and the
  commissioning write surviving a reboot. QEMU emulates no Wi-Fi PHY or
  audio, and a warm restart is out of contract (the emulated NIC survives a
  soft reset), so each boot is one QEMU process; Wi-Fi, I2S capture, and the
  codec remain hardware-only surfaces.

Add a tool as a module in `src/streamline_tools/` with a console entry point in
`pyproject.toml` and, if it needs one, a run target in the Makefile.
