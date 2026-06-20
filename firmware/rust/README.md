# Rust Firmware Spike

This directory is a greenfield Rust/ESP-IDF implementation spike for the
original ESP32 Audio Kit. It intentionally has no Arduino or PlatformIO
dependency. The working C++ firmware in `../streamline` remains the hardware
reference until this implementation meets its acceptance criteria.

## Current boundary

The first stage establishes the parts that can be verified without a board:

- byte-exact `ELI1` protocol header encoding
- configuration validation and audio setting bounds
- explicit setup/streaming lifecycle policy
- bounded stream telemetry model
- Docker-only Cargo build for `xtensa-esp32-espidf`

The binary only links ESP-IDF and emits a serial log line. It does not yet
configure Wi-Fi, NVS, HTTP, ES8388, I2S, or TCP. This makes the first flash
safe: it cannot change stored settings or start the audio pipeline.

## Architecture target

```text
src/
  config.rs       validated application settings
  mode.rs         lifecycle state and transitions
  protocol.rs     bridge wire contract
  telemetry.rs    report-window value types
  adapters/       ESP-IDF NVS, Wi-Fi, HTTP, codec, I2S, TCP, FreeRTOS
  services/       provisioning, capture, streaming, status
  main.rs         dependency composition only
```

`adapters/` and `services/` are added as hardware capabilities are proven. The
audio path must retain the established 32-item drop-oldest queue, core-1 task
affinity, capture priority 3, network priority 2, bounded raw TCP connection,
and one coalesced 1,048-byte write per packet.

## Commands

All commands run in Docker:

```sh
make firmware-rust-format
make firmware-rust-lint
make firmware-rust
```

The project pins the original ESP32 target and ESP-IDF `v5.5.3`, following the
current `esp-idf-template` defaults. No flash target exists until the first
hardware capability is implemented and reviewed.
