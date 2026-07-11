# Firmware

The firmware is a Rust application on ESP-IDF. It captures board-described
line-in audio, applies the signal gate, sends framed PCM to a bridge, and serves
the device API and console.

[Architecture](../../docs/architecture.md#firmware-boundaries) owns the layer
boundaries and boot flow. The [PCM protocol](../../docs/pcm-protocol.md),
[TCP transport](../../docs/tcp-transport.md), [OTA reference](../../docs/ota.md),
and [security notes](../../docs/security.md) own their runtime contracts.

Build, test, flash, and monitor commands live in the
[root README](../../README.md#development). Follow [AGENTS.md](../../AGENTS.md)
for contribution and device-smoke requirements.
