# Bridge reference

The bridge accepts StreamLine PCM on TCP `39000` in one selected mode at a
time: cleartext or authenticated TLS 1.3. It serves live WAV on HTTP `8088`.
It owns producer authentication, packet playout, source lifecycle, HTTP client
fan-out, and an optional lossless recording store. It does not retain source
pipelines across a restart or identify a device by hostname.

One owner-set **bridge API token** (`STREAMLINE_API_TOKEN`, or the add-on's
`api_token` option) authorizes every bridge mutation: the listener mode, the
device-key map, and recordings. The bridge console unlocks with it once and
locks all of those controls together.

## Endpoints

| Endpoint | Contract |
| --- | --- |
| `/streamline.wav` | Live WAV from the sole source, or a pending pipeline before a producer connects. |
| `/streamline.wav?source=<source>` | Live WAV from an IPv4 cleartext source or authenticated TLS key id. |
| `/status` | Bridge version, per-source playout/client statistics, latest PCM levels, and lifecycle state. |
| `/health` | `200 OK` with `ok` while the required PCM listener is ready; `503` after a listener failure. |
| `/api/openapi.json` | OpenAPI 3.1 contract generated from the running bridge routes and Pydantic models. |
| `/` and `/recordings` | Bridge console with live sources and optional recordings. The Home Assistant add-on serves it through ingress. |
| `/api/recordings/*` | Recording capabilities and authenticated file/session operations. |
| `/api/transport` | Listener state, enrolled key ids, and authentication counters; never PSKs. |
| `/api/sendspin` | Music Assistant publishing state of every source; never pairing secrets. |
| `/api/sendspin/sources/<source>/pairing-token` | Authenticated `POST` that replaces the source's pairing secret and returns its pairing token, shown only in this response. |
| `/api/transport/mode` | Authenticated `PUT` selecting `cleartext` or `tls-psk`; a change drops live producers. |
| `/api/transport/keys/<key-id>` | Authenticated `PUT` and `DELETE` key mutations, available in either mode. |
| `/api/unlock` | Authenticated no-op the console uses to check the bridge API token. |

When more than one source exists, an unqualified `/streamline.wav` request
returns `409` and lists the available source ids. Invalid source values return
`400`; unknown source ids return `404`.

After the first audio buffer fills, HTTP WAV output keeps its sample cadence.
If PCM stops long enough to trigger rebuffering, the bridge sends silence while
waiting for fresh audio. The outage-silence limit bounds packet-loss concealment
and resets sequence tracking; it does not cut off the HTTP stream. Resumed audio
fills the learned playout target before replacing silence. The
[adaptive buffer](pcm-protocol.md#adaptive-buffering) adjusts during explicit
source silence or rebuffering. Slow HTTP clients
still face the write deadline and bounded output queue.

## Source lifecycle

A cleartext source is keyed by its TCP peer IPv4 address. An encrypted source
is keyed by its authenticated device key id; its lifecycle also reports the
peer IPv4 address and `tls-psk` transport. `source_allow` always checks the peer
address. An allowlisted address remains addressable before a cleartext source
connects. The lifecycle reports peer admission as `open` or `allowlisted`
independently from identity retention. A TLS key identity is dynamic even when
its peer is allowlisted. A dynamic source is `connected` while its TCP producer is active,
`http-selected` while an HTTP client holds it open, and `disconnected` after
both end. A bare WAV request waits for the first producer when no source exists.
With one allowlisted address, it uses that address's pipeline, which the peer's
authenticated producer can adopt; once that identity is evicted, the address is
addressable again. A cleartext producer never takes over a source that owes
another allowlisted address, so at capacity it waits for that source's
eviction. Explicit `?source=` listeners, recordings,
and Sendspin streams pin their selected identity and prevent adoption under a
different identity.

The bridge retains an inactive dynamic source for
`--source-eviction-idle-seconds` (300 seconds by default). A reconnect during
that interval reuses its playout pipeline. An active TCP producer, HTTP
client, recording session, or Sendspin stream prevents eviction. Eviction and bridge shutdown
stop and join the source's playout worker, so churned sources never accumulate
threads. The `/status` lifecycle block reports the state, admission policy,
consumer counts, current idle duration, and eviction interval.

Each playout buffer admits at most one second of audio beyond
`--max-playout-buffer-seconds`. A producer that sends faster than real time past
that ceiling is disconnected, and the source's `overflows` counter records it;
the buffer also drops its stored packets whenever an outage forces a
re-buffer, so a stalled stream cannot strand memory.

Each source snapshot also includes `levels`, the peak and RMS absolute sample
values for the latest accepted 16-bit stereo PCM packet, and `signal`:
`present` when that packet carried audio, `absent` when it was a silence
record, and `null` before the source session's first packet. Each channel ranges
from `0` (silence) through `32768` (full scale). The bridge console polls this
open JSON contract once per second and renders the values as a live meter.

The bridge owns [its OpenAPI artifact](bridge-openapi.json). Console checks use
that artifact to generate a typed client; do not edit generated client files.

## Tuning options

| Option | Default | Constraint | Meaning |
| --- | ---: | --- | --- |
| `--tcp-port` | 39000 | integer 1..65535 | PCM listener for the selected mode. |
| `--http-port` | 8088 | integer 1..65535 | HTTP WAV, status, and control listener. |
| `--transport-state-file` | empty | writable path | Private listener mode and device-key state. Encryption control is disabled when empty. |
| `--source-allow` | empty | IPv4 addresses | Repeat or comma-separate allowed producer addresses. |
| `--max-sources` | 8 | integer 1..32 | Maximum retained source pipelines. |
| `--max-http-connections` | 32 | integer 1..128 | Maximum simultaneous HTTP workers. Excess connections are rejected. |
| `--http-request-timeout-seconds` | 10.0 | finite number 0.001..3600 | Progress deadline for every HTTP phase: header reads, body reads, response writes, and keep-alive idling. A client stalled past it is disconnected; healthy streams are unaffected. |
| `--client-buffer-chunks` | 2048 | integer 1..4096 | Per-client output queue depth in 1 KiB chunks. Full queues evict the client. |
| `--playout-buffer-seconds` | 1.0 | finite number 0.001..60 | Minimum adaptive playout target. |
| `--max-playout-buffer-seconds` | 3.0 | finite number 0.001..60, at least the minimum | Maximum adaptive playout target; equal bounds select fixed buffering. |
| `--max-repeat-conceal-packets` | 3 | integer 0..256 | Loss packets that repeat attenuated PCM before silence. |
| `--max-outage-silence-seconds` | 5.0 | finite number 0.001..300 | Concealed outage before playout re-buffers. |
| `--source-idle-timeout-seconds` | 5.0 | finite number 0.001..3600 | Producer read deadline and TCP keepalive interval; established streams may gate silence. |
| `--source-eviction-idle-seconds` | 300.0 | finite number 0.001..86400 | Inactive dynamic source retention interval. |
| `--sendspin-server-url` | empty | `ws://` or `wss://` URL | Music Assistant Sendspin server that receives every source as a Live Input. Publishing is disabled when empty. |
| `--sendspin-state-dir` | empty | writable directory | Private Sendspin client identities and pairings. Required with `--sendspin-server-url`. |

Home Assistant exposes the owner-facing tuning options. Its add-on adapter
owns the private transport-state path and Sendspin state directory, normalizes `source_allow`, and omits
settings that the Supervisor did not provide.

The bridge binds the PCM listener before it starts HTTP. An invalid or occupied
PCM address therefore fails process startup instead of exposing an HTTP service
that cannot receive audio.

`--max-http-connections` is the number of application requests the bridge
admits at once. The server adapter includes Uvicorn's current connection in its
boundary accounting, so a limit of one serves one request. During shutdown,
active HTTP responses have five seconds to finish before the server cancels
them and closes PCM and recording workers.

## Encrypted devices

Encryption is switched from the bridge console (or `PUT /api/transport/mode`),
not by a deployment option, so the coordinated cutover with the device happens
in one place. The mode and the enrolled device keys persist together in the
transport state file: Compose uses the private `transport-data` volume at
`/data/transport.json`; the Home Assistant add-on uses its
Supervisor-owned `/data` directory. The file is mode `0600`, bounded,
owned by the bridge process user, validated before its contents are parsed, and
replaced atomically after each mutation. The bridge fails closed when a mounted
state file grants any group or world access or belongs to another user.

The bridge console accepts the one-time key id and PSK from the device console
in either listener mode, so a credential can be enrolled before the switch.
The same operations are available as authenticated API requests. Follow the
[transport enable, credential replacement, and recovery workflow](tcp-transport.md#enable-encryption)
instead of editing the state file.

## Music Assistant live inputs

The bridge publishes each device's source to Music Assistant as a Sendspin
source client, so the source appears under Live Inputs and plays on any Music
Assistant player, stereo pair, or group. Set `--sendspin-server-url` to the
Sendspin server of Music Assistant 2.10.9 or later, normally
`ws://<music-assistant-host>:8927/sendspin`, and `--sendspin-state-dir` to a
private writable directory. Publishing requires the bridge API token. The
Home Assistant add-on exposes the URL as `sendspin_server_url` and keeps its
state in `/data/sendspin`.

One Sendspin client represents one source id and dials the server itself, so
the bridge needs no multicast or host networking. Its X25519 identity and its
pairing store persist in `<state-dir>/<source>/`, so the source keeps its
Music Assistant identity and pairing across bridge restarts. A cleartext
source is identified by its IPv4 address, so an address change appears as a
new source; a TLS source keeps its key id. The client connects once a device
has connected under the source's identity and disconnects when the source is
evicted. A pending slot or an allowlisted address that no device has used yet
stays unpublished: it is a placeholder whose identity is unknown until a device
connects.

Pairing uses Music Assistant's token method:

1. Open the bridge console's **Settings → Music Assistant** and create a
   pairing token for the source, or call
   `POST /api/sendspin/sources/<source>/pairing-token` with the bridge API
   token.
2. In Music Assistant, run the setup of the device named `StreamLine
   <source>` and paste the token.

Each token request replaces the source's pairing secret, so an earlier token
stops working; an existing pairing is unaffected. A token stays valid until
the next request replaces it. It carries a secret, so only the creating
response returns it. A request that times out returns `503` with
`sendspin-busy`; it may already have replaced the secret, so create another
token.

The device signal gate becomes Sendspin `line_sense`: the client reports
`present` while a connected source sends audio and `absent` during silence
records or while the device is disconnected. Music Assistant can then start
the input on a chosen player when a record starts and stop it after a minute
without signal.

Audio flows only between Music Assistant's source `start` and `stop`
commands. While it flows, the client holds a Sendspin lease on the source,
which keeps the source from eviction like an HTTP client or recording, and
the source lifecycle counts it in `sendspin_streams`. The client sends the
accepted packets as 48 kHz, 16-bit stereo PCM, with silence records as zeros,
before any playout concealment. Each packet is timestamped at its capture
time: its sequence position plus the smallest arrival offset observed, so a
burst that a Wi-Fi stall releases keeps its original spacing. The Sendspin
client drops capture older than 500 ms, so a stall that holds back more
audio than that loses the older part on this path; the HTTP playout buffer
of 1 to 3 seconds absorbs the same stall. The device's drop-oldest send
queue holds 256 ms of audio and its TCP send buffer about 60 ms more, so a
device's backlog stays under that bound. Music Assistant owns jitter
buffering, drift correction, and target latency for this path. HTTP WAV
clients and recordings receive the same source unchanged.

## Recordings

Recording is disabled unless the deployment supplies writable storage. Set
`--recordings-dir` (or `STREAMLINE_RECORDINGS_DIR`) and the bridge API token
for a standalone bridge. For Compose, set the directory to `/recordings`; its
named volume owns the files. Home Assistant users enable recordings in the
add-on options. Open `http://<bridge-host>:8088/` (or `/recordings`) to
record, download, or delete files. Home Assistant opens the same console
through the add-on's ingress Web UI.

[Lossless recordings](recordings.md) defines the user flow, API, resource
limits, timeline reconstruction, and storage lifecycle.

## Player address

`--public-url http://192.0.2.20:8088` advertises the HTTP base address that
external players can reach. Home Assistant exposes the same setting as
`public_url`. Include the published HTTP port and any reverse-proxy prefix;
do not include credentials, a query, or a fragment. Restart the bridge after
changing deployment options.

`GET /status` reports this address as `public_url`. The console keeps its
management requests on the ingress path, but builds playback links from the
advertised address. Without an advertised address, a directly opened bridge
uses its HTTP origin; an ingress console asks for configuration and does not
copy an authenticated ingress link. The address must expose the WAV route to
the player without the browser's Home Assistant session.
