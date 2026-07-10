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
- publish the stream for Music Assistant, Snapcast, or Icecast
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

### Music Assistant

The primary path. Add the bridge's `/streamline.wav` URL to Music Assistant as a
radio stream; it plays directly, or routes through Snapcast when Music Assistant
controls Snapcast clients. The Home Assistant add-on is the simplest way to run
the bridge.

### Snapcast

Best when synchronized multiroom playback matters. Convert the PCM stream into a
local FIFO or TCP stream, then point Snapserver at it.

### Icecast / Liquidsoap

Best when a client needs an encoded stream instead of live WAV. Put Liquidsoap
after the bridge to encode FLAC/Opus/MP3 and publish an HTTP stream.

### Sendspin

Out of scope. Sendspin is Music Assistant's playback protocol for output devices;
this device produces audio entering the media system, so it publishes a stream
URL instead.

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

Home Assistant OS and Supervised installs can run the same bridge through the
`ha-addon/` add-on repository entry. The add-on exposes TCP `39000` for ESP32
PCM and HTTP `8088` for `/streamline.wav`, `/status`, and `/health`.

Set each ESP32 TCP target to the bridge host IP and port `39000`. Add
`http://<bridge-host>:8088/streamline.wav` to Music Assistant as a radio URL, or
`http://<bridge-host>:8088/streamline.wav?source=<esp32-ip>` to pick one of
several sources. Start audio on the source before adding the URL: an idle node
sends no audio, and Music Assistant rejects a stream it cannot probe. To serve a
client that needs an encoded stream, put Liquidsoap/Icecast after the bridge to
publish FLAC/MP3/Opus.

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

Named audio profiles group the input, gain, and attenuation settings behind a
versioned board-bound model. The device keeps up to eight short profile records
in NVS and applies a selected profile live. The waveform does not identify the
source. An external selector that knows the source state can call the same
activation API as the console. [Audio profiles](audio-profiles.md) owns the
contract.

The firmware exports read-only runtime state as JSON at `/api/status` and as
Prometheus text at `/api/metrics`. Both endpoints read the same in-memory
identity, network, and streaming counters.

## HTTP API Shape

The host-testable Rust `api` module owns endpoint paths, methods, authentication,
request bodies, response bodies, and schema constraints. The ESP-IDF adapter
registers those endpoint declarations and serializes or deserializes their DTOs.
It contains no independent route strings or form-field map.

A host-only `utoipa` feature generates [the OpenAPI 3.1 contract](openapi.json)
from the Rust module. `make firmware-openapi` refreshes the checked-in artifact;
`make firmware-openapi-check` fails when it is stale. The device serves the same
artifact at `GET /api/openapi.json`.

The console runs `openapi-typescript` before lint, test, and build, then uses
`openapi-fetch` against the generated paths. TypeScript rejects an unknown path,
method, form field, or response shape. The console's API tab renders the served
contract, so integrations and the UI inspect the same document.

Endpoint paths use nouns for state and verbs for actions. Reads are open. Every
write requires the admin key ([security.md](security.md)). Responses carry
`rebooting: true` when a change restarts the device, so clients react to the
response instead of assuming.
