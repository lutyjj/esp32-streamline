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

The device sends raw PCM with a small fixed header. The wire format is transport-
agnostic (see `docs/pcm-protocol.md`); the current transport is a persistent TCP
connection using raw lwIP sockets. Earlier builds used UDP, but UDP cannot recover
lost packets and the first Arduino `WiFiClient` TCP attempt was unstable, so the
firmware now uses raw sockets with a split capture/network task design. See
`docs/tcp-idf-transport-plan.md` for the full rationale and results.

Format:

```text
sample rate: 48000 Hz
channels:    2
sample size: 16-bit signed little-endian
payload:     interleaved stereo PCM
transport:   TCP (raw lwIP sockets)
```

At 48 kHz stereo 16-bit, raw payload bitrate is about 1.536 Mbit/s before header/
TCP/IP/Wi-Fi overhead. That is comfortable for a local Wi-Fi network and much
simpler than encoding on the ESP32.

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

Sendspin is the native Music Assistant playback protocol for clients/players. It is
not the right first target for this line-in bridge, because our ESP32 is producing
audio that needs to enter the media system, not a player waiting for Music Assistant
to send it audio. A Sendspin implementation could be useful later for output devices,
but the line-in path should publish a stream URL or feed Snapcast/Icecast.

## HTTP WAV Bridge

`bridge` is the deployable HTTP WAV bridge:

```text
ESP32 TCP PCM -> bridge -> http://host:8088/streamline.wav
```

It exposes:

```text
/streamline.wav  live HTTP WAV stream
/status       JSON bridge stats
/health       health check
```

Run directly:

```sh
make bridge-up
```

Run with Docker:

```sh
make bridge-up
```

Set the ESP32 TCP target to the bridge host IP and port `39000`. For Music
Assistant, add `http://<bridge-host>:8088/streamline.wav` as a URL/radio stream. If
Music Assistant proves unreliable with live WAV, keep this bridge and add
Liquidsoap/Icecast after it to publish FLAC/MP3/Opus.

## Codec Discovery

The next firmware should scan I2C on likely Audio Kit pins:

```text
SDA GPIO33
SCL GPIO32
```

Detected on this board:

```text
SDA GPIO33 / SCL GPIO32 -> 0x10
```

Detected addresses determine the driver path:

```text
0x1A -> AC101 candidate
0x10 -> ES8388 candidate  <-- current board
```

The firmware owns a minimal typed ES8388 register sequence for this board. It
does not depend on an Arduino codec abstraction.

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

The streaming task exports queue and transport counters via `/api/status`.
