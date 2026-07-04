# Firmware

Rust on ESP-IDF v5.5.3 for the ESP32 Audio Kit. Build, flash, and check
commands live in the [root README](../../README.md#development); the
architecture rules live in [AGENTS.md](../../AGENTS.md).

## Runtime

- ES8388 ADC at I2C `0x10` (SDA GPIO33, SCL GPIO32)
- I2S RX at 48 kHz, 16-bit stereo (MCLK GPIO0, BCLK GPIO27, LRCLK GPIO25, DIN GPIO35)
- byte-exact `ELI1` TCP packets, 256 frames / 1,024 PCM bytes — see the
  [PCM protocol](../../docs/pcm-protocol.md)
- signal-gated streaming: packets flow only while the input plays, decided
  by thresholds calibrated to the tracked noise floor plus amplitude and
  time hysteresis (`src/play.rs`)
- bounded 32-packet drop-oldest queue; capture task on core 1 priority 3,
  TCP task on core 1 priority 2 — see the
  [TCP transport contract](../../docs/tcp-transport.md)
- bounded TCP connect/send via `std::net` (`TCP_NODELAY`, 250 ms timeouts)
- NVS-backed configuration and a setup AP at `esp32-streamline-XXXX`
- mDNS console advertisement at `streamline-xxxx.local` in station mode
- HTTP config/status API: open reads; a per-device admin key gates writes —
  see the [security notes](../../docs/security.md)
- embedded web console built from `../../console`

The host-testable core (`config`, `levels`, `packet`, `play`, `protocol`,
`update`) lives in the crate root; ESP-IDF stays behind `adapters/`.
