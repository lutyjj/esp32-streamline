# Design Notes

## Decision

Use the ESP32-A1S Audio Kit as a remote analog-to-network bridge, but do not make it
responsible for the whole media system.

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

## Codec

The codec sits on I2C on the Audio Kit pins:

```text
SDA GPIO33
SCL GPIO32
```

The board's codec answers at `0x10`:

```text
0x10 -> ES8388  <-- current board
0x1A -> AC101   <-- other ESP32-A1S variant
```

The firmware owns a minimal typed ES8388 register sequence behind a `Codec`
trait, so other ESP32-A1S codec variants can be added as their own
implementation without touching the capture or transport paths.

## Capture Bring-Up

The production Rust capture adapter uses:

```text
codec:       ES8388 at 0x10
I2C:         SDA GPIO33 / SCL GPIO32
I2S:         MCLK GPIO0 / BCLK GPIO27 / LRCLK GPIO25 / DIN GPIO35
sample rate: 48000 Hz
format:      16-bit stereo I2S
input:       ES8388 line input 1 or 2 (NVS configured)
gain:        0-100 (NVS configured)
```

The firmware exports read-only runtime state as JSON at `/api/status` and as
Prometheus text at `/api/metrics`. Both endpoints read the same in-memory
streaming counters.

## HTTP API Shape

Endpoint paths follow one rule: nouns for state, verbs for actions.

- Reads are open: `GET /api/status` (runtime), `GET /api/metrics`
  (Prometheus), `GET /api/settings` (persisted settings, no secrets).
- Settings writes are one group per endpoint under the noun they change:
  `POST /api/settings/network`, `/api/settings/audio`, `/api/settings/name`,
  `/api/settings/admin-key`.
- Device-wide actions are top-level verbs: `POST /api/unlock`,
  `POST /api/restart`, `POST /api/factory-reset`, `POST /api/ota/check`,
  `POST /api/ota/update`.

Every write requires the admin key ([security.md](security.md)). Responses
carry `rebooting: true` when the change restarts the device, so clients react
to what the device says rather than assuming.
