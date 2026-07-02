# ESP32 StreamLine

[![CI](https://github.com/lutyjj/esp32-streamline/actions/workflows/ci.yml/badge.svg)](https://github.com/lutyjj/esp32-streamline/actions/workflows/ci.yml)

ESP32 StreamLine turns an ESP32 Audio Kit into a network line-in source. It
captures analog audio — a turntable, a CD deck — and streams the raw PCM over
TCP/Wi-Fi to a self-hosted bridge. The bridge publishes a live HTTP WAV stream
for Snapcast, Icecast, or Music Assistant.

## Features

- **Dumb node architecture** — the ESP32 captures and moves packets. Encoding,
  buffering, and syncing live on the bridge. See [design notes](docs/design.md).
- **Zero-config commissioning** — an unconfigured device opens a setup AP. A
  small web console sets Wi-Fi, stream target, and audio levels. A per-device
  admin key gates every write; reads stay open.
- **Signal-gated streaming** — the device streams while the input plays and
  pauses on sustained silence, so an idle input costs no bandwidth.
- **Self-hosted bridge** — one Docker container turns the TCP PCM stream into
  a live HTTP WAV stream. A ~1 s playout buffer smooths Wi-Fi jitter and
  conceals gaps. See the [PCM protocol](docs/pcm-protocol.md).
- **Verified OTA updates** — one console button pulls the latest GitHub
  release over HTTPS, verifies its SHA-256, and rolls back automatically if
  the new image fails to boot. See [OTA updates](docs/ota.md).

The device speaks plain HTTP on a trusted LAN. Read the
[security notes](docs/security.md) before exposing any port.

## Hardware

- **Board**: Ai-Thinker ESP32-A1S / ESP32 Audio Kit v2.2 class
- **Codec**: ES8388 (I2C address `0x10`)
- **Flash**: 8 MB

## Quick start

### 1. Flash the firmware

**Browser** — open the [WebFlasher](https://lutyjj.github.io/esp32-streamline/)
in desktop Chrome or Edge, connect the board over USB, and click
**Connect & Install**.

**Terminal** — download the latest `streamline-X.Y.Z-full.bin` from
[Releases](../../releases), then flash it with
[esptool](https://docs.espressif.com/projects/esptool/) (`pip install esptool`):

```sh
esptool.py -p /dev/ttyUSB0 -b 460800 write_flash 0x0 streamline-X.Y.Z-full.bin
```

Adjust `-p` to your port: `/dev/cu.usbserial-0001` on macOS, `COM3` on Windows.

### 2. Run the bridge

Create `docker-compose.yml` on your server and start it with
`docker compose up -d`:

```yaml
services:
  streamline-http:
    image: ghcr.io/lutyjj/esp32-streamline-bridge:latest
    restart: unless-stopped
    ports:
      - "39000:39000/tcp"
      - "8088:8088/tcp"
    # environment:
    #   STREAMLINE_SOURCE_ALLOW: 192.168.1.100  # accept PCM only from your ESP32
```

The stream goes live at `http://<bridge-host>:8088/streamline.wav` — add it to
Music Assistant as a radio/URL stream. With several ESP32 sources, select one
with `http://<bridge-host>:8088/streamline.wav?source=<esp32-ip>`. `/status`
serves per-source JSON stats. `make bridge-run BRIDGE_ARGS='--help'` lists the
tuning flags.

### 3. Configure the device

1. Join the `esp32-streamline-XXXX` Wi-Fi network and open `http://192.168.71.1/`.
2. Enter your Wi-Fi credentials and set **TCP Target Host** to the bridge IP.
3. **Save the generated admin key.** The device never shows it again. The key
   unlocks every later settings change; lose it and you must reflash.
4. Save. The device reboots onto your network.

Open the console at the device's station IP to tune audio, change settings, or
reset the device. **Clear Config** returns it to the setup AP.
For monitoring, scrape `http://<esp32-ip>/api/metrics`; JSON diagnostics live at
`/api/status`.

### 4. Update

Console → **Advanced** → **Check for updates**. [OTA updates](docs/ota.md)
covers the flow, rollback, and the one-time serial reflash that pre-OTA
devices need.

## Development

Everything builds and checks in containers — install only Docker (or Podman)
and `make`. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the PR flow;
[AGENTS.md](AGENTS.md) states the engineering rules.

```sh
make help                                 # all targets
make lint && make test                    # what CI runs
make firmware-build                       # cross-compile the firmware
make firmware-flash PORT=/dev/ttyUSB0     # flash from the host
make firmware-monitor PORT=/dev/ttyUSB0   # interactive serial monitor
make firmware-capture CAPTURE_SECS=30     # bounded serial capture for scripts
make bridge-up                            # run the bridge from source
```

Flashing runs on the host because Docker Desktop on macOS cannot reliably
expose serial devices. Install the tool once: `cargo install espflash`.

Docs: [design](docs/design.md) ·
[PCM protocol](docs/pcm-protocol.md) ·
[TCP transport](docs/tcp-transport.md) ·
[OTA](docs/ota.md) ·
[security](docs/security.md)

### Releases

Releases are tag-based. Set the same version in `bridge/pyproject.toml` and
`firmware/streamline/Cargo.toml` through the normal PR flow, then:

```sh
make release VERSION=0.4.0   # validates and builds deliverables; publishes nothing
git tag v0.4.0
git push github v0.4.0       # the tag workflow publishes to GitHub and GHCR
```

## Scope

StreamLine is an audio ingestion source, not a network renderer. It captures
and transports; playback, encoding, and multiroom sync belong to the software
consuming the stream.

## AI usage

AI contributions are welcome — this project is built with heavy AI usage.
Agents: follow [AGENTS.md](AGENTS.md).
