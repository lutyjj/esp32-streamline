# Design Notes

This document records architectural decisions. [Architecture](architecture.md)
maps the current components, runtime flows, state ownership, and build topology.

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

### Encrypted PCM transport

Use TLS 1.2 with a 256-bit, per-device pre-shared key and
`TLS_PSK_WITH_AES_128_GCM_SHA256` (`PSK-AES128-GCM-SHA256` in OpenSSL) for
encrypted PCM. Keep the ELI1 frame unchanged inside the TLS byte stream. TLS
terminates in the firmware TCP adapter and at the bridge socket edge, so
capture, framing, retry policy, playout, and fanout remain host-testable and
transport-independent.

This is an accepted implementation direction, not the current wire contract.
The released device and bridge continue to use cleartext TCP until the linked
implementation and migration work is complete.

#### Evidence

Disposable prototypes exercised cleartext TCP,
[Noise](https://noiseprotocol.org/noise.pdf)
`Noise_NNpsk0_25519_ChaChaPoly_SHA256`, and TLS-PSK through the same firmware
capture path and production bridge media pipeline. The supported ESP32 board
streamed 48 kHz stereo for at least ten uninterrupted minutes per candidate.
Measurements use the same packet size, Wi-Fi power policy, bridge
host, container image, and instrumentation build. Device task CPU is a share
of total two-core capacity. Send-block time is the firmware socket-write time,
used as a transport-path latency proxy because ELI1 has no sender timestamp.

| Measurement | Cleartext control | Noise NNpsk0 | TLS 1.2 PSK |
|---|---:|---:|---:|
| Device handshake | 85.6 ms | 361.5 ms | 258.7 ms |
| Bridge handshake | Not applicable | 49.4 ms | 41.5 ms |
| Network task CPU, median (range) | 3.57% (3.33–3.60) | 21.10% (20.98–21.21) | 14.81% (14.76–14.86) |
| Capture task CPU, median (range) | 4.91% (4.72–4.95) | 5.27% (5.22–5.29) | 4.13% (4.10–4.16) |
| Send-block time, median (range) | 1.34 ms (1.29–1.70) | 4.99 ms (4.91–5.08) | 2.55 ms (2.53–2.59) |
| Free heap after handshake | 102.9 KiB | 91.7 KiB | 75.4 KiB |
| Minimum free heap during run | 65.1 KiB | 52.6 KiB | 45.0 KiB |
| OTA application image | 1,651,616 B | 1,726,800 B | 1,641,968 B |
| Bridge CPU, median (range) | 7.25% (6.95–7.71) | 12.94% (10.42–14.38) | 10.06% (8.67–11.41) |
| Bridge RSS, median | 50.6 MiB | 49.6 MiB | 50.6 MiB |
| Continuous connection | 606.8 s | 649.3 s | 639.7 s |
| Device packets after snapshot | 113,738 | 110,273 | 107,777 |
| Queue drops after snapshot | 35 (0.031%) | 648 (0.588%) | 31 (0.029%) |
| Network errors during run | 0 | 0 | 0 |
| Bridge underruns | 0 | 0 | 0 |
| Bridge restart to source | 2.14 s | 1.65 s | 1.38 s |
| Wrong-key result | Not applicable | Rejected | Rejected |

All candidates sustained the 1.536 Mbit/s offered load. Steady-state free heap
remained within 97.3–98.6 KiB for cleartext, 80.2–88.0 KiB for Noise, and
62.0–71.8 KiB for TLS, with no downward trend. One-minute send-block maxima
varied from 106 to 302 ms across candidates and were dominated by Wi-Fi
stalls. Queue drops therefore reflect both radio conditions and transport
headroom; Noise dropped the most packets despite the strongest measured radio
signal. Each bridge restart result measures wall time from container start to
an authenticated source, except cleartext, which has no authentication.

Noise provides compact authenticated encryption and fresh ephemeral keys, but
the prototype used about six times the cleartext network-task CPU, required a
larger task stack for X25519, and added 75,184 bytes to the OTA image. The
evaluated Python implementations are Alpha packages: the newer
[`noiseframework`](https://pypi.org/project/noiseframework/) package failed a
direct Snow NNpsk0 interop vector, while the interoperable
[`noiseprotocol`](https://pypi.org/project/noiseprotocol/) 0.3.1 package has no
release newer than 2020 and its
[repository](https://github.com/plizonczyk/noiseprotocol) lists peer review and
side-channel work as TODOs. Neither is an acceptable production trust
boundary.

TLS-PSK uses maintained
[ESP-TLS](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32/api-reference/protocols/esp_tls.html)
and [Python/OpenSSL](https://docs.python.org/3.14/library/ssl.html#ssl.SSLContext.set_psk_server_callback)
interfaces, stays within the measured device budget, and needs no certificate
authority. The production bridge runtime must require Python 3.13 or newer for
server-side PSK callbacks. Pure PSK cipher suites do not provide forward
secrecy: compromise of a device PSK can expose sessions recorded with that key.
DHE-PSK could add forward secrecy, but the supported ESP32 build does not
enable finite-field Diffie-Hellman and its extra cost does not fit this LAN
appliance threat model.

A formal cleartext exception does not meet the goal because it neither hides
audio nor authenticates a source. Certificate TLS adds certificate issuance,
naming, and renewal without improving the single-owner commissioning path. A
VPN makes encryption depend on external network infrastructure. A custom AEAD
record layer duplicates mature protocol work, while DTLS and QUIC replace the
proven reliable-stream transport. These remain deployment options or future
decisions, not competing product transports.

#### Security and lifecycle contract

- Generate an independent random 256-bit PCM PSK per device. Never derive it
  from or reuse the HTTP admin key.
- Use a non-secret key id as the TLS client identity. The bridge maps key ids
  to PSKs and supports many devices without sharing one fleet key.
- Store active and pending key slots plus an active marker. Staging,
  activation, rollback, and retirement are failure-atomic across flash writes.
- Rotate by staging a key through the authenticated device API, provisioning
  it on the bridge, proving a connection, activating it, and retiring the old
  key after a bounded rollback window. Recover a lost PCM key through the
  admin API; recover a lost admin key by reflashing.
- Rely on the TLS AEAD sequence and fresh handshake randoms to reject record
  replay and tampering within and across sessions. Treat the authenticated key
  id, not the source IP address, as source identity.
- Configure cleartext and TLS-PSK as explicit modes on separate listeners.
  An encrypted device never retries in cleartext. A migration may run both
  listeners for legacy devices, then disable the cleartext listener.
- Keep provisioning, verification, rotation, rollback, and recovery available
  through APIs. The console only drives those contracts.

The implementation is split into reviewable contracts for
[protocol versioning](https://github.com/lutyjj/esp32-streamline/issues/182),
[key lifecycle](https://github.com/lutyjj/esp32-streamline/issues/184),
[firmware](https://github.com/lutyjj/esp32-streamline/issues/185),
[bridge](https://github.com/lutyjj/esp32-streamline/issues/188),
[migration](https://github.com/lutyjj/esp32-streamline/issues/187),
[documentation](https://github.com/lutyjj/esp32-streamline/issues/183), and
[hardware qualification](https://github.com/lutyjj/esp32-streamline/issues/186).

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
several sources. Start audio on the source before adding the URL: an idle device
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
  resolved at boot, and accepted only when its compiled codec driver supports
  its I2C address, input lines, gain range, and attenuation range. The
  descriptor is capped below ESP-IDF's NVS string limit, so this path is for one selected board definition rather than a
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

The console runs Orval before lint, test, and build. Orval generates types and
operation-named Fetch functions from the contract. The hand-written
`deviceFetch` adapter owns admin-key injection, error normalization, and the
replaceable transport used by tests. TypeScript rejects an unknown operation,
form field, or response shape. The console's API tab renders the served contract,
so integrations and the UI inspect the same document.

Endpoint paths use nouns for state and verbs for actions. Reads are open. Every
write requires the admin key ([security.md](security.md)). Responses carry
`rebooting: true` when a change restarts the device, so clients react to the
response instead of assuming.

## QEMU Image Variant

Espressif's QEMU fork emulates the ESP32 but no Wi-Fi PHY, I2S, or codec, so
the production image can boot under emulation only until Wi-Fi bring-up. The
`qemu` cargo feature builds a variant that reaches the network through the
emulated OpenCores Ethernet MAC (`-nic user,model=open_eth`) and skips audio
bring-up; everything else — bootloader, partition table, NVS, board
resolution, the HTTP API, the embedded console — is the shared code the
hardware image runs. `make -C firmware qemu-artifacts` builds it, and
`make tools-smoke-qemu` runs the emulated-device test suite against it.

Two limits bound what emulation can prove. Radio, capture, and codec behavior
exist only on hardware, so the device smoke stays the release gate. And a
software restart is out of contract under QEMU — the emulated NIC survives a
warm CPU reset that real hardware would clear, and its stale interrupt
crashes the next boot — so the test suite runs QEMU with `-no-reboot` and
treats each boot as one process over the persistent flash file.
