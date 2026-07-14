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

Encrypted PCM uses TLS 1.3 external PSK with ephemeral ECDHE (`psk_dhe_ke`) and
`TLS_AES_128_GCM_SHA256`. Each device has an independent random 256-bit PSK and
a versioned non-secret identity. ECDHE provides forward secrecy: learning a
device PSK does not decrypt recorded sessions.

TLS terminates in the firmware TCP adapter and at the bridge socket edge.
Capture, ELI1 framing, retry policy, playout, and fanout stay host-testable and
transport-independent. [TCP transport](tcp-transport.md) owns the exact
session, key lifecycle, migration, and recovery contract. The
[machine-readable contract](pcm-transport.json) mechanically checks shared
Rust and Python constants.

#### Evidence

The selection covers cleartext, Noise, custom AEAD records, certificate TLS,
TLS 1.2 PSK, TLS 1.3 PSK, VPN encapsulation, DTLS, and QUIC.

| Candidate | Source authentication | Forward secrecy | Fit |
|---|---|---|---|
| Cleartext TCP | No | No | Compatibility mode only |
| Noise NNpsk0 | Yes | Yes | ESP32 CPU/stack cost and immature Python packages |
| Custom AEAD records | Depends on design | Depends on design | Duplicates protocol, replay, and key-schedule work |
| Certificate TLS | Yes | Yes | Adds issuance, naming, and renewal to single-owner setup |
| TLS 1.2 pure PSK | Yes | No | Lower handshake cost, but recorded sessions depend on PSK secrecy |
| TLS 1.3 external PSK + ECDHE | Yes | Yes | Selected; native maintained boundaries and no certificate authority |
| VPN | Depends on deployment | Depends on deployment | Makes device security depend on external infrastructure |
| DTLS or QUIC | Yes | Yes | Replaces the proven ordered stream without a product need |

[ESP-TLS](https://docs.espressif.com/projects/esp-idf/en/v5.5.3/esp32/api-reference/protocols/esp_tls.html)
and [Python/OpenSSL](https://docs.python.org/3.14/library/ssl.html#ssl.SSLContext.set_psk_server_callback)
provide the selected client and server boundaries. The firmware enables only
TLS 1.3 PSK with ephemeral key exchange. The bridge requires the exact TLS
version and cipher before it creates a source.

The supported ESP32 and Python 3.14 bridge negotiate the exact profile with a
736.8 ms device handshake. The session consumes 36,476 bytes of device heap,
keeps at least 75,300 bytes free, and streams more than 140 MB of 48 kHz stereo
PCM for over ten uninterrupted minutes with zero network errors. The OTA image
is 1,687,008 bytes, 83.04% of its application partition. Wrong keys and unknown
identities fail before source admission.

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
`ha-addon/` add-on repository entry. The add-on exposes TCP `39000` for
cleartext or authenticated TLS 1.3 PCM and HTTP `8088` for `/streamline.wav`,
`/status`, and `/health`.

Set each ESP32 target to the bridge host and port `39000`; the bridge and device
select cleartext or TLS for that same destination. Add
`http://<bridge-host>:8088/streamline.wav` to Music Assistant as a radio URL, or
`http://<bridge-host>:8088/streamline.wav?source=<source-id>` to pick one of
several sources. Start audio on the source before adding the URL: an idle device
sends no audio, and Music Assistant rejects a stream it cannot probe. To serve a
client that needs an encoded stream, put Liquidsoap/Icecast after the bridge to
publish FLAC/MP3/Opus.

## Board support

StreamLine targets ESP32 boards that can feed 48 kHz stereo PCM into I2S.
The application treats board facts as data: a board descriptor names the
descriptor id, display name, codec driver id, codec address, ESP32 audio pin
map, input labels, audio limits, and an optional local analog output. Settings
validation, status capabilities, audio hardware initialization, and console
controls read that descriptor.

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

### Local analog output

A board descriptor may advertise one `analog_passthrough` output with a codec
line number and user-facing jack label. Absence means unsupported. Codec
validation accepts the descriptor only when every advertised input and the
output line form a supported hardware route.

The Ai-Thinker ESP32 Audio Kit preset routes the selected `LIN1/RIN1` or
`LIN2/RIN2` pair through the ES8388 analog bypass mixer to `LOUT2/ROUT2`, which
feeds the board's 3.5 mm output. The signal does not pass through the ADC,
ESP32, or DAC. The route uses fixed 0 dB mixer and output settings. The unused
`LOUT1/ROUT1` speaker path and its GPIO-controlled amplifier stay off.

`POST /api/settings/analog-passthrough` persists the desired On/Off state. The
settings response reports that intent; status reports intent, observed active
state, and an optional codec fault. Enabling is rejected on an unsupported
board. A codec write failure mutes and powers down the output pair, keeps the
desired state available for diagnosis or retry, and reports the route inactive.
The firmware also reconciles a persisted route while opening the recovery AP,
so a Wi-Fi startup fault does not make the local audio path depend on the
network.

The selected input drives both PCM capture and local output. An input change
mutes the output around the route switch. Input gain, ADC attenuation, level
calibration, silence detection, and network faults do not change or disable the
analog path. The console calls this feature **Analog passthrough** and exposes
no firmware volume control; listening volume belongs to connected equipment.

Named audio profiles group the input, gain, and attenuation settings behind a
versioned board-bound model. The device keeps up to eight short profile records
in NVS and applies a selected profile live. The waveform does not identify the
source. An external selector that knows the source state can call the same
activation API as the console. [Audio profiles](audio-profiles.md) owns the
contract.

## LEDs

A board descriptor advertises the LEDs it wires as `leds`, each with a stable
`id`, a console `label`, a `gpio`, an `active_low` polarity, and a
`default_role`. The user assigns each LED one role, stored per board LED id in
`led_roles` on the runtime configuration:

- **status** renders the device state through one shared pattern: one flash in
  setup, two when ready but idle, steady while streaming, three on a startup
  fault. `crate::indicator` owns the pattern.
- **on** and **off** hold the LED steadily lit or dark.

A LED with no assignment uses its descriptor `default_role`, so a board author
can wire a status light and leave decorative LEDs dark without any user action.
`POST /api/settings/led` takes an `id` and a `role`; the render task reads the
live configuration, so a change applies without a reboot. `/api/status` reports
each LED under `capabilities.leds`, the effective role under `led_roles`, and
whether any LED currently renders status under `indicator.available`.

The role set is forward-looking: a new signal such as an available update adds
one role variant and one render rule, not a matrix of every signal against every
LED. The official ES8388 preset wires one status light on GPIO22; a custom
descriptor can declare up to eight LEDs.

The firmware exports read-only runtime state as JSON at `/api/status` and as
Prometheus text at `/api/metrics`. Both endpoints read the same in-memory
identity, network, and streaming counters, plus device-resource headroom —
RAM, NVS storage, uptime, and task count — sampled on demand.

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
