# ESP32 StreamLine

ESP32 StreamLine turns an ESP32 Audio Kit into a network line-in source. It captures analog audio (like from a vinyl record player or CD deck), packetizes the raw PCM and sends it over a persistent TCP/Wi-Fi connection to a self-hosted bridge for ingestion into systems like Snapcast, Icecast, or Music Assistant.

## Features

- **Dumb Node Architecture**: The ESP32 stays simple—capturing and moving packets. All encoding, buffering, and syncing lives on the bridge.
- **Secure-by-default configuration**: Starts an `esp32-streamline-XXXX` setup AP if unconfigured. Configuration changes are accepted only from setup mode; the optional normal-mode web console is read-only.
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

## Getting Started

### Build and Flash

PlatformIO is run inside Docker, so you don't need the ESP32 toolchain installed on your host machine.

1. **Build the firmware:**
   ```sh
   make firmware-streamline
   ```

2. **Flash to the board:**
   *Note: Docker Desktop on macOS does not reliably expose `/dev/cu.*` serial devices, so flashing requires `esptool` installed on your host.*
   ```sh
   make firmware-flash FIRMWARE_TARGET=streamline
   ```
   *If you are on Linux or Windows, override the default macOS port:*
   ```sh
   make firmware-flash FIRMWARE_TARGET=streamline PORT=/dev/ttyUSB0  # Linux
   make firmware-flash FIRMWARE_TARGET=streamline PORT=COM3          # Windows
   ```

3. **Monitor serial output:**
   ```sh
   make firmware-monitor PORT=/dev/ttyUSB0
   ```

For a published release, use the single `streamline-<version>-full.bin` asset
and flash it at offset `0x0`:

```sh
esptool --chip esp32 --port /dev/cu.usbserial-0001 --baud 460800 write-flash \
  0x0 streamline-<version>-full.bin
```

The release also includes separate bootloader, partition, and application images
for advanced use; the `full.bin` image is the default customer install path.

### Configuration

If no config is saved, the device will host an open setup network named `esp32-streamline-XXXX`.
1. Connect to the network and open `http://192.168.4.1/`.
2. Enter your home Wi-Fi credentials.
3. Set the **TCP Target Host** to the IP of your bridge server.
4. Save and let the device reboot onto your network.

To change settings later, connect over serial and enter `setup`. The device starts
the setup AP again while retaining the current values for review and editing.

### HTTP WAV Bridge

Run the HTTP bridge on your server or host machine to receive the TCP stream and expose it as an HTTP stream.

**Via Docker Compose:**
```sh
make bridge-up
```

**Direct Docker image:**
```sh
make bridge-run
```

Your audio will now be available as a live WAV stream at `http://<bridge-host>:8088/streamline.wav`. You can add this URL directly to Music Assistant as a radio/web stream.

The HTTP bridge defaults to a 1 second playout buffer. It smooths timing jitter from the TCP stream and keeps the audio timeline stable by concealing missing packets instead of skipping over them. Status is exposed as JSON at `http://<bridge-host>:8088/status`.

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
