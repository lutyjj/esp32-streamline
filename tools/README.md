# Tools

Host-side developer utilities, packaged as one project (`streamline-tools`).
Nothing here ships to users or runs on the device. The layout mirrors
`bridge/`: one `pyproject.toml`, one `Dockerfile`, one `Makefile` with the
standard verbs (`format`, `lint`, `image`) plus run targets.

## Layout

- `src/streamline_tools/device/`: the library for driving one StreamLine
  device, real or emulated. One module per concern: `flash_image` prepares
  merged images for QEMU, `capture` reads serial output to a boot marker,
  `boot_log` judges a captured transcript, `api` talks to the device HTTP
  surface, `checks` is the shared result model.
- `src/streamline_tools/smoke.py`: the `streamline-smoke` CLI over that
  library.
- `smoke/`: the device test suite (pytest + pytest-embedded) over the same
  library.
- `src/streamline_tools/analysis/`: the capture-versus-reference analyzer.
  One module per concern: `signal` is the shared stereo-frame type, `decode`
  reads files into frames, `align` recovers the lag, `transform` scores channel
  mappings, `measure` reports level and spectral stats, and `report` renders
  those typed results behind the `streamline-analyze` CLI.
- `src/streamline_tools/serial_capture.py`: standalone serial capture tool
  with its own entry point.

## Commands

- `streamline-analyze` (`make tools-analyze REF=ref.flac CAP=capture.wav`)
  compares a captured stream against its reference audio and reports offset,
  drift, and quality metrics.
- `streamline-capture`: bounded, non-interactive serial capture. Stdlib-only
  so `make firmware-capture` can run it with the system `python3`; the serial
  port is a host resource containers cannot reach.
- `streamline-smoke`: serial boot sanity for the USB-connected board:
  `make tools-smoke-device` resets it and verifies the boot transcript
  through Wi-Fi mode resolution on the host `python3`, then runs the device
  suite below against the board. Pass `--json` for a machine-readable report.

## Device test suite

The tests in `smoke/` see the device through its API, so the same tests run
on both targets: `make tools-smoke-qemu` boots the QEMU image variant
(`make -C firmware qemu-artifacts`) per test; `make tools-smoke-device` runs
the suite against the real board's URL after the serial check. Tests that
need a fresh flash image, serial boot expectations, or destructive lifecycle
transitions (commissioning persistence, key gating, factory reset, the OTA
slot switch) carry the `emulated` marker and skip on hardware with a reason.

QEMU emulates no Wi-Fi PHY or audio, and a warm restart is out of contract
(the emulated NIC survives a soft reset), so each emulated boot is one QEMU
process over the persistent flash file; Wi-Fi, I2S capture, and the codec
remain hardware-only surfaces.

Add a tool as a module in `src/streamline_tools/` with a console entry point in
`pyproject.toml` and, if it needs one, a run target in the Makefile.

### Debug a failed emulated run

Boots and OTA assertions run once; a failed boot fails the test. The runner
retains flash and eFuse files in `tools/.smoke-qemu/pytest/` and serial logs in
`tools/.smoke-qemu/serial/`. The next run replaces the pytest directory, so
copy a failed run before running again.

CI uploads this state as `qemu-failure-<commit>-<attempt>` when the smoke job
fails. Its `qemu-firmware-images-<commit>` artifact includes the matching
`streamline-qemu.elf` and `streamline-qemu-fail-management.elf`. Both artifacts
expire after three days.

For a guest panic, extract the core dump from the flash image's `coredump`
partition, defined in `firmware/streamline/partitions.csv`. Decode it with
ESP-IDF's `esp-coredump info_corefile -t raw -c crash.bin <matching.elf>` in
the firmware container. Match the executable to the crashed image, including
its variant: the panic's ELF digest identifies it. The shared Cargo target
directory can hold a different variant after packaging.

These artifacts contain synthetic emulated-device state. Hardware credentials
and captures remain local; `make tools-smoke-device` does not use this output
directory.
