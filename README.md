# ESP32 StreamLine

[![CI](https://github.com/lutyjj/esp32-streamline/actions/workflows/ci.yml/badge.svg)](https://github.com/lutyjj/esp32-streamline/actions/workflows/ci.yml)

ESP32 StreamLine turns a supported ESP32 line-in board into a network audio
source. It captures analog audio — a turntable, a CD deck — and streams the raw
PCM over TCP/Wi-Fi to a self-hosted bridge. The bridge publishes a live HTTP
WAV stream. Music Assistant plays it as a radio URL; Snapcast, Icecast, or any
HTTP consumer can read it too.

## Features

- **Dumb device architecture** — the ESP32 captures and moves packets. Encoding,
  buffering, and syncing live on the bridge. See [design notes](docs/design.md).
- **Zero-config commissioning** — an unconfigured device opens a setup AP. A
  small web console joins Wi-Fi, then handles the stream target and audio
  levels. A per-device admin key gates every write; reads stay open.
- **Signal-gated streaming** — the device streams while the input plays and
  pauses on sustained silence, so an idle input costs no bandwidth.
- **Source profiles**: save complete input settings for sources such as CD
  and vinyl, switch them live from the console or API, and share the versioned
  board-bound catalog. See [audio profiles](docs/audio-profiles.md).
- **Self-hosted bridge** — one Docker container turns the TCP PCM stream into
  a live HTTP WAV stream. A ~1 s playout buffer smooths Wi-Fi jitter and
  conceals gaps. See the [PCM protocol](docs/pcm-protocol.md).
- **Opt-in encrypted PCM** — TLS 1.3 authenticates each device with its own
  key and provides forward secrecy. Cleartext remains available for first
  setup and explicit recovery. See [PCM transport](docs/tcp-transport.md).
- **Lossless recording**: an optional bridge page and API preserve one source
  as a finite 48 kHz, 16-bit stereo WAV, with sequence gaps measured and
  represented as silence. See [lossless recordings](docs/recordings.md).
- **Verified automatic OTA updates** — the device pulls new GitHub releases
  over HTTPS, verifies their SHA-256, and rolls back automatically if an image
  fails to boot. See [OTA updates](docs/ota.md).

The device speaks plain HTTP on a trusted LAN. Read the
[security notes](docs/security.md) before exposing any port.

## Hardware

- **Official preset**: Ai-Thinker ESP32 Audio Kit v2.2 (ES8388)
- **Codec**: ES8388 (I2C address `0x10`)
- **Flash**: 4 MB or larger

Board support is descriptor-driven: presets define the codec, I2C/I2S pin map,
input labels, and audio limits. Official presets and BYOD descriptors use the
same JSON contract when the codec driver is compiled into the firmware. The
release firmware is a generic ESP32 app image with an embedded official
descriptor catalog. See
[design notes](docs/design.md#board-support).

### Status light

A board with a status light flashes once in setup, twice when ready but idle,
stays lit while streaming, and flashes three times on a startup fault.
`GET /api/status` reports the selected state under `indicator`.

## Quick start

### 1. Flash the firmware

**Browser** — open the [WebFlasher](https://lutyjj.github.io/esp32-streamline/)
in desktop Chrome or Edge, connect the board over USB, and click
**Connect & Install**.

**Terminal** — download the latest `streamline-X.Y.Z-full.bin` from
[Releases](https://github.com/lutyjj/esp32-streamline/releases), then flash it with
[esptool](https://docs.espressif.com/projects/esptool/) (`pip install esptool`):

```sh
esptool.py -p /dev/ttyUSB0 -b 460800 write_flash 0x0 streamline-X.Y.Z-full.bin
```

Adjust `-p` to your port: `/dev/cu.usbserial-0001` on macOS, `COM3` on Windows.

### 2. Run the bridge

**Home Assistant OS / Supervised**: add this repository as a Home Assistant
add-on repository, install **ESP32 StreamLine Bridge**, and start it. The add-on
publishes the same ports as the container: cleartext PCM on `39000/tcp`,
encrypted PCM on `39001/tcp`, and HTTP WAV on `8088/tcp`.

**Docker** — create `docker-compose.yml` on your server and start it with
`docker compose up -d`:

```yaml
services:
  streamline-http:
    image: ghcr.io/lutyjj/esp32-streamline-bridge:latest
    restart: unless-stopped
    ports:
      - "39000:39000/tcp"
      - "39001:39001/tcp"
      - "8088:8088/tcp"
    environment:
      STREAMLINE_SOURCE_ALLOW: ${STREAMLINE_SOURCE_ALLOW:-}
      STREAMLINE_RECORDINGS_DIR: ${STREAMLINE_RECORDINGS_DIR:-}
      STREAMLINE_RECORDING_TOKEN: ${STREAMLINE_RECORDING_TOKEN:-}
      STREAMLINE_TRANSPORT_API_TOKEN: ${STREAMLINE_TRANSPORT_API_TOKEN:-}
    command:
      - --cleartext-enabled
      - ${STREAMLINE_CLEARTEXT_ENABLED:-true}
      - --tls-enabled
      - ${STREAMLINE_TLS_ENABLED:-false}
      - --tls-keys-file
      - /data/transport-keys.json
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp
    volumes:
      - streamline-recordings:/recordings
      - streamline-transport:/data

volumes:
  streamline-recordings:
  streamline-transport:
```

The stream goes live at `http://<bridge-host>:8088/streamline.wav`. Add it to
Music Assistant as a radio/URL stream, with audio already playing on the source:
an idle device sends no audio, and Music Assistant rejects a stream it cannot
probe. With several ESP32 sources, select one with
`http://<bridge-host>:8088/streamline.wav?source=<source-id>`. `/status` serves
per-source JSON stats. `make bridge-run BRIDGE_ARGS='--help'` lists the tuning
flags.

To record, enable the bridge's writable volume and set a token of at least 16
characters before `docker compose up -d`:

```sh
export STREAMLINE_RECORDINGS_DIR=/recordings
export STREAMLINE_RECORDING_TOKEN=replace-with-a-private-token
```

Open `http://<bridge-host>:8088/recordings`. The named Docker volume owns the
files; recording stays disabled when `STREAMLINE_RECORDINGS_DIR` is empty. The
Home Assistant add-on exposes the same opt-in flow in its configuration. This
focused bridge page manages stored files; the device console continues to own
audio, network, and firmware settings.

Set `STREAMLINE_SOURCE_ALLOW` to the device IPv4 address, or a comma-separated
list, whenever those addresses are stable. Keep ports `39000`, `39001`, and
`8088` on a trusted LAN; none is an internet-facing service.

### 3. Configure the device

1. Join the `esp32-streamline-XXXX` Wi-Fi network and open `http://192.168.71.1/`.
2. Enter your Wi-Fi credentials and continue to the generated admin key.
3. **Save the generated admin key.** The device never shows it again. The key
   unlocks every later settings change; lose it and you must reflash.
4. Join. The device reboots onto your network and advertises its console as
   `http://streamline-xxxx.local/`.
5. Open the station console, then set the bridge host in **Network** and
   calibrate from **Audio**. Save a source profile when several players need
   different input levels.

Cleartext PCM is the compatibility default. To encrypt it, enable the bridge's
TLS listener, generate and provision the per-device key from the two consoles,
verify it from the device, then activate encryption. Follow the
[complete cutover and recovery workflow](docs/tcp-transport.md#enable-encryption).

Open the console at its `.local` name to tune audio, change settings, or reset
the device. Use the station IP if your network does not pass mDNS. For
monitoring, scrape `http://<esp32-host>/api/metrics`; JSON diagnostics live at
`/api/status`.

### 4. Update

Daily automatic updates are enabled by default and wait for idle audio. Console
→ **System** → **Firmware** can switch to weekly, disable them, check immediately,
or install manually. [OTA updates](docs/ota.md) covers the flow, rollback, and
the one-time serial reflash that pre-OTA devices need.

## Development

Everything builds and checks in containers — install only Docker (or Podman)
and `make`. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup and the PR flow;
[AGENTS.md](AGENTS.md) states the engineering rules.

```sh
make help                                 # all targets
make lint && make test                    # local baseline before a PR
make repository-check                      # docs, metadata, and release versions
make firmware-build                       # cross-compile the firmware
make firmware-flash PORT=/dev/ttyUSB0     # flash from the host
make firmware-monitor PORT=/dev/ttyUSB0   # interactive serial monitor
make firmware-capture CAPTURE_SECS=30     # bounded serial capture for scripts
make bridge-up                            # run the bridge from source
```

Flashing runs on the host because Docker Desktop on macOS cannot reliably
expose serial devices. Install the tool once: `cargo install espflash`.

Docs: [architecture](docs/architecture.md) ·
[bridge reference](docs/bridge.md) ·
[lossless recordings](docs/recordings.md) ·
[design](docs/design.md) ·
[user journey](docs/user-journey.md) ·
[audio profiles](docs/audio-profiles.md) ·
[PCM protocol](docs/pcm-protocol.md) ·
[TCP transport](docs/tcp-transport.md) ·
[OTA](docs/ota.md) ·
[security](docs/security.md)

### Releases

Use **Actions → Prepare release** with a stable `X.Y.Z` target version. The workflow creates
a draft `release/X.Y.Z` PR after it prepares and validates the release snapshot.
Merging that PR verifies its merge commit again, creates `vX.Y.Z`, and starts
publishing from the tag.

For a local release snapshot, start from a clean release branch and run:

```sh
make release VERSION=0.6.0
```

The command updates the checked-in version files and generated add-on
changelog, then runs release verification. Commit those changes in a release
PR. Never edit the changelog by hand.

## Scope

StreamLine is an audio ingestion source, not a network renderer. It captures
and transports; playback, encoding, and multiroom sync belong to the software
consuming the stream.

## AI usage

AI contributions are welcome — this project is built with heavy AI usage.
Agents: follow [AGENTS.md](AGENTS.md).
