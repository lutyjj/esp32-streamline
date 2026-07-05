# Design Notes

## Decision

Use a supported ESP32 line-in board as a remote analog-to-network bridge, but
do not make it responsible for the whole media system.

The ESP32 should:

- initialize the audio codec
- capture 16-bit stereo PCM from I2S
- timestamp or sequence packets
- send packets over Wi-Fi to a fixed bridge
- expose simple diagnostics over serial or HTTP

The bridge host should:

- absorb Wi-Fi jitter
- optionally resample
- publish the stream to Snapcast or Icecast
- handle player compatibility and multiroom behavior

## Protocol Choice

The device sends raw PCM with a small fixed header. The wire format is
transport-agnostic — [pcm-protocol.md](pcm-protocol.md) defines it — and the
transport is a persistent TCP connection (Rust `std::net` over lwIP). TCP
gives ordered, recoverable delivery, and the split capture/network task design
keeps a network stall from blocking I2S capture.
[tcp-transport.md](tcp-transport.md) states the runtime contract.

At 48 kHz stereo 16-bit, the raw payload bitrate is about 1.536 Mbit/s before
header/TCP/IP/Wi-Fi overhead. That is comfortable for a local Wi-Fi network
and much simpler than encoding on the ESP32.

## Server Integration Options

### Snapcast

Best option if synchronized playback matters. Run a small bridge that converts the
PCM stream into a local FIFO or TCP stream, then point Snapserver at it.

### Icecast / Liquidsoap

Best option if broad compatibility matters. Run a bridge that exposes PCM or WAV,
then let Liquidsoap encode to FLAC/Opus/MP3 and publish an HTTP stream.

### Music Assistant

Treat the final stream as a normal radio/URL stream or route it through Snapcast if
Music Assistant is controlling Snapcast clients.

### Sendspin

Out of scope. Sendspin is Music Assistant's playback protocol for output devices;
this device produces audio entering the media system, so it publishes a stream URL
or feeds Snapcast/Icecast instead.

## HTTP WAV Bridge

`bridge` is the deployable HTTP WAV bridge:

```text
ESP32 TCP PCM -> bridge -> http://host:8088/streamline.wav
```

It exposes:

```text
/streamline.wav              live HTTP WAV stream
/streamline.wav?source=<ip>  live HTTP WAV stream from one ESP32 source
/status                      per-source JSON bridge stats
/health                      health check
```

Run it:

```sh
make bridge-up
```

Set each ESP32 TCP target to the bridge host IP and port `39000`. For Music
Assistant, add `http://<bridge-host>:8088/streamline.wav` as a URL/radio stream
when one ESP32 feeds the bridge, or
`http://<bridge-host>:8088/streamline.wav?source=<esp32-ip>` for a specific
source. If Music Assistant proves unreliable with live WAV, keep this bridge and
add Liquidsoap/Icecast after it to publish FLAC/MP3/Opus.

## Board support

StreamLine targets ESP32 boards that can feed 48 kHz stereo PCM into I2S.
The application treats board facts as data: a board descriptor names the
descriptor id, display name, codec driver id, codec address, ESP32 audio pin map,
input labels, and audio limits. Settings validation, status capabilities,
audio hardware initialization, and console controls read that descriptor.

Board support has three tiers:

- **Official presets** are JSON descriptors in
  `firmware/streamline/boards/`, compiled into the firmware catalog, and
  tested on real hardware. The device stores the selected descriptor id in
  NVS, resolves it at boot, and reboots after a preset change because pins and
  codec selection are boot-time hardware wiring. A preset name is concrete:
  vendor, board family or revision, and codec variant when that affects
  behavior.
- **Custom descriptors** use the same JSON contract as official presets. A
  user-supplied descriptor is posted to `/api/settings/board`, stored in NVS,
  resolved at boot, and accepted only when it names a codec driver compiled
  into the firmware. The descriptor is capped below ESP-IDF's NVS string
  limit, so this path is for one selected board definition rather than a
  downloaded board library.
- **Custom firmware** covers boards that need a new codec driver, different
  clocking, or hardware behavior outside the descriptor contract. The hardware
  layer changes there; capture, transport, settings, and the console stay on
  the descriptor and API contracts.

The hardware adapter converts validated descriptor GPIO numbers into erased
ESP-IDF HAL pins; the capture and codec adapters receive those pins without
naming a board.

The release firmware is a generic ESP32 app image plus an embedded official
descriptor catalog. Per-board binaries are useful when a build needs a
different compiled driver set, a smaller catalog, or hardware behavior that is
not expressible as descriptor data.

## Codec

The resolved board descriptor names the codec driver and the 7-bit I2C address.
The Ai-Thinker ESP32 Audio Kit v2.2 ES8388 preset descriptor uses these I2C
control pins:

```text
SDA GPIO33
SCL GPIO32
```

The known ESP32-A1S codec addresses are:

```text
0x10 -> ES8388
0x1A -> AC101
```

Each board descriptor has a stable id, a display name, a codec driver id with
its I2C address, an ESP32 audio pin map, and the user-facing audio limits.
Built-in presets and custom board descriptors use the same shape and validation
rules. The firmware resolves the descriptor's codec driver id to a typed driver
in the codec adapter. A new codec chip adds its driver and one resolver entry;
the capture, transport, settings, and HTTP paths keep reading the board
descriptor.

## Capture Bring-Up

The production Rust capture adapter uses:

```text
codec:       board descriptor's codec at its I2C address
I2C:         board descriptor's SDA/SCL pins
I2S:         board descriptor's MCLK/BCLK/LRCLK/DIN pins
sample rate: 48000 Hz
format:      16-bit stereo I2S
input:       board descriptor's line input (NVS configured)
gain:        0-100 (NVS configured)
```

The firmware exports read-only runtime state as JSON at `/api/status` and as
Prometheus text at `/api/metrics`. Both endpoints read the same in-memory
identity, network, and streaming counters.

## HTTP API Shape

Endpoint paths follow one rule: nouns for state, verbs for actions.

- Reads are open: `GET /api/status` (runtime), `GET /api/metrics`
  (Prometheus), `GET /api/settings` (persisted settings, no secrets),
  `GET /api/boards` (built-in board catalog and selected descriptor).
- Settings writes are one group per endpoint under the noun they change:
  `POST /api/settings/network`, `/api/settings/audio`, `/api/settings/name`,
  `/api/settings/admin-key`, `/api/settings/board`.
- Device-wide actions are top-level verbs: `POST /api/unlock`,
  `POST /api/restart`, `POST /api/factory-reset`, `POST /api/ota/check`,
  `POST /api/ota/update`.

Every write requires the admin key ([security.md](security.md)). Responses
carry `rebooting: true` when the change restarts the device, so clients react
to what the device says rather than assuming.
