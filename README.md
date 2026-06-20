# ESP32 StreamLine

ESP32 StreamLine turns an ESP32 Audio Kit into a network line-in source. It captures analog audio (like from a vinyl record player or CD deck), packetizes the raw PCM and sends it over a persistent TCP/Wi-Fi connection to a self-hosted bridge for ingestion into systems like Snapcast, Icecast, or Music Assistant.

## Features

- **Dumb Node Architecture**: The ESP32 stays simple—capturing and moving packets. All encoding, buffering, and syncing lives on the bridge.
- **Zero-config commissioning**: Starts an `esp32-streamline-XXXX` setup AP when unconfigured; set Wi-Fi, stream target, and audio from a small web console and tune levels live while streaming. A per-device console secret set at commissioning gates all config writes; reads stay open. Traffic is plain HTTP, so keep the device on a trusted LAN — see [Security Notes](docs/security.md).
- **Easily Self-Hosted Bridge**: Includes Python scripts and Docker Compose files to bridge the TCP PCM stream into a live HTTP WAV stream.
- **Bridge Playout Buffer**: The bridge buffers the stream before exposing the WAV output, smoothing timing jitter and concealing any gaps around disconnects.

## Hardware

Developed and tested on:
- **Board**: Ai-Thinker ESP32-A1S / ESP32 Audio Kit v2.2 class board
- **Codec**: ES8388 (detected at I2C address `0x10`)
- **Flash**: 8 MB

## Architecture

```text
vinyl/CD switch
  -> ESP32 Audio Kit line input
  -> codec ADC over I2S
  -> ESP32 packetizes PCM over TCP/Wi-Fi
  -> HTTP WAV bridge
  -> live HTTP WAV stream (/streamline.wav)
  -> Music Assistant / players
```

## Quick Start

### 1. Flash the Firmware

1. Download the latest `esp32-streamline-vX.Y.Z-merged.bin` from [Releases](../../releases).
2. Flash it to your ESP32 Audio Kit using `esptool.py` (install via `pip install esptool`):
   ```sh
   esptool.py -p /dev/ttyUSB0 -b 460800 write_flash 0x0 esp32-streamline-vX.Y.Z-merged.bin
   ```
   *(Adjust `-p` to your serial port, e.g., `/dev/cu.usbserial-0001` on macOS or `COM3` on Windows)*

### 2. Run the HTTP Bridge

**Via Docker Compose:**
Create a `docker-compose.yml` file on your server:
```yaml
services:
  streamline-http:
    image: ghcr.io/lutyjj/esp32-streamline-bridge:latest
    restart: unless-stopped
    ports:
      - "39000:39000/tcp"
      - "8088:8088/tcp"
    environment:
      # Optional: Restrict bridge input to your ESP32's IP
      # STREAMLINE_SOURCE_ALLOW: 192.168.1.100
```
Then start it: `docker compose up -d`

**Via direct Docker command:**
```sh
docker run -d --restart unless-stopped -p 39000:39000 -p 8088:8088 ghcr.io/lutyjj/esp32-streamline-bridge:latest
```

Your audio will now be available as a live WAV stream at `http://<bridge-host>:8088/streamline.wav`. You can add this URL directly to Music Assistant as a radio/web stream. Status is exposed as JSON at `http://<bridge-host>:8088/status`.

The HTTP bridge defaults to a 1 second playout buffer. It smooths timing jitter from the TCP stream and keeps the audio timeline stable by concealing missing packets instead of skipping over them.

### 3. Configuration

If no config is saved, the device will host an open setup network named `esp32-streamline-XXXX`.
1. Connect to the network and open `http://192.168.4.1/`.
2. Enter your home Wi-Fi credentials.
3. Set the **TCP Target Host** to the IP of your bridge server.
4. Set a **Console Secret** (minimum 8 characters) — you'll need it to change
   settings later. Save it; the console keeps it as your token automatically.
5. Save and let the device reboot onto your network.

Once it is on your network, open the device's web console at its station IP and
enter the console token to change Wi-Fi, target, or audio settings at any time;
each save reboots to apply. Reads (status) stay open; writes require the token.
Resetting configuration returns the device to the setup AP. Traffic is plain HTTP,
so keep the device on a trusted LAN (see [Security Notes](docs/security.md)). If you
lose the secret, re-commission by reflashing.

## Advanced Usage & Development

### Building from Source

The Rust/ESP-IDF firmware is built in Docker. Flashing is host-side because
Docker Desktop does not reliably expose macOS serial devices.

1. **Build the firmware:**
   ```sh
   make firmware-build
   ```

2. **Flash to the board:**
   *Note: Docker Desktop on macOS does not reliably expose `/dev/cu.*` serial devices, so flashing requires `esptool` installed on your host.*
   ```sh
   cargo install espflash
   make firmware-flash
   ```
   *If you are on Linux or Windows, override the default macOS port:*
   ```sh
   make firmware-flash PORT=/dev/ttyUSB0  # Linux
   make firmware-flash PORT=COM3          # Windows
   ```

3. **Monitor serial output:**
   ```sh
   make firmware-monitor PORT=/dev/ttyUSB0
   ```

Release artifacts contain an `espflash`-compatible merged image plus the ELF.

### Running the Bridge from Source

Run the HTTP bridge on your server or host machine to receive the TCP stream and expose it as an HTTP stream.

**Via Docker Compose:**
```sh
make bridge-up
```

**Direct Docker image:**
```sh
make bridge-run
```

Useful bridge options:

```sh
make bridge-run BRIDGE_ARGS='\
  --source-allow 192.0.2.10 \
  --playout-buffer-seconds 1.0 \
  --client-buffer-chunks 2048 \
  --max-repeat-conceal-packets 3 \
  --max-outage-silence-seconds 5.0 \
  --source-idle-timeout-seconds 5.0'
```

`--source-allow` is optional but recommended: provide the ESP32's IPv4 address
(repeat the argument or use a comma-separated list for multiple sources). The same
setting is available to Docker Compose as `STREAMLINE_SOURCE_ALLOW`.

Read [Security Notes](docs/security.md) before exposing either bridge port outside
your trusted LAN.

### Checks

Format the repository, run all static checks, and run the bridge tests plus every
firmware build without installing a local toolchain:

```sh
make format
make lint
make test
```

### Releases

Releases are tag-based. Set the version in `bridge/pyproject.toml`, build the
local release deliverables, then create the matching tag through the normal
pull-request workflow:

```sh
make release VERSION=0.1.1
git tag v0.1.1
git push github v0.1.1
```

`make release` runs the checks, writes firmware binaries and checksums to
`dist/firmware`, and builds the versioned bridge image. It does not publish.
The tag workflow publishes those deliverables to GitHub and GHCR.

## Scope

ESP32 StreamLine is an audio ingestion source, not a network renderer. It focuses
on reliable analog capture and transport; playback, encoding, and multiroom
synchronization belong to the software consuming the published stream.

## AI usage
AI usage and contributions are more than welcome. This project was created with heavy usage of AI.
