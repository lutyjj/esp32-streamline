# Firmware

The ESP32 Audio Kit firmware: Rust on ESP-IDF v5.5.3.

## Runtime

- ES8388 ADC at I2C `0x10` (SDA GPIO33, SCL GPIO32)
- I2S RX at 48 kHz, 16-bit stereo (MCLK GPIO0, BCLK GPIO27, LRCLK GPIO25, DIN GPIO35)
- byte-exact `ELI1` TCP packets, 256 frames / 1,024 PCM bytes
- bounded 32-packet drop-oldest queue
- capture task: core 1, priority 3; TCP task: core 1, priority 2
- bounded TCP connect/send via `std::net` (`TCP_NODELAY`, 250 ms timeouts)
- NVS-backed configuration and a setup AP at `esp32-streamline-XXXX`
- HTTP config/status API: open reads, writes gated by a per-device admin key
  (bearer token) generated at commissioning (trusted LAN; see `docs/security.md`)

The embedded web UI lives in `web/index.html`. The application core is split
between typed configuration/protocol modules, ESP-IDF adapters, and the task
runtime rather than a monolithic board sketch.

## Commands

```sh
make firmware-format
make firmware-lint
make firmware-test
make firmware-build
```

Builds and tests run in Docker. Flashing is intentionally host-side because
Docker Desktop cannot reliably access macOS serial devices:

```sh
cargo install espflash
make firmware-flash PORT=/dev/cu.usbserial-0001
make firmware-monitor PORT=/dev/cu.usbserial-0001
```
