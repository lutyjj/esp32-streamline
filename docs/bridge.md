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
| `/api/transport/mode` | Authenticated `PUT` selecting `cleartext` or `tls-psk`; a change drops live producers. |
| `/api/transport/keys/<key-id>` | Authenticated `PUT` and `DELETE` key mutations, available in either mode. |
| `/api/unlock` | Authenticated no-op the console uses to check the bridge API token. |

When more than one source exists, an unqualified `/streamline.wav` request
returns `409` and lists the available source ids. Invalid source values return
`400`; unknown source ids return `404`.

## Source lifecycle

A cleartext source is keyed by its TCP peer IPv4 address. An encrypted source
is keyed by its authenticated device key id; its lifecycle also reports the
peer IPv4 address and `tls-psk` transport. `source_allow` always checks the peer
address. An allowlisted address remains addressable before a cleartext source
connects. The lifecycle reports peer admission as `open` or `allowlisted`
independently from identity retention. A TLS key identity is dynamic even when
its peer is allowlisted. A dynamic source is `connected` while its TCP producer is active,
`http-selected` while an HTTP client holds it open, and `disconnected` after
both end. A bare WAV request creates a `pending` dynamic pipeline that the first
producer adopts.

The bridge retains an inactive dynamic source for
`--source-eviction-idle-seconds` (300 seconds by default). A reconnect during
that interval reuses its playout pipeline. An active TCP producer or HTTP
client or recording session prevents eviction. The `/status` lifecycle block
reports the state, admission policy, consumer counts, current idle duration,
and eviction interval.

Each source snapshot also includes `levels`, the peak and RMS absolute sample
values for the latest accepted 16-bit stereo PCM packet. Each channel ranges
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
| `--http-request-timeout-seconds` | 10.0 | finite number 0.001..3600 | Socket inactivity before an HTTP client is disconnected. |
| `--client-buffer-chunks` | 2048 | integer 1..4096 | Per-client output queue depth in 1 KiB chunks. Full queues evict the client. |
| `--playout-buffer-seconds` | 1.0 | finite number 0.001..60 | Packets buffered before playout begins or resumes. |
| `--max-repeat-conceal-packets` | 3 | integer 0..256 | Loss packets that repeat attenuated PCM before silence. |
| `--max-outage-silence-seconds` | 5.0 | finite number 0.001..300 | Concealed outage before playout re-buffers. |
| `--source-idle-timeout-seconds` | 5.0 | finite number 0.001..3600 | Inactive TCP connection timeout. |
| `--source-eviction-idle-seconds` | 300.0 | finite number 0.001..86400 | Inactive dynamic source retention interval. |

Home Assistant exposes the owner-facing tuning options. Its add-on adapter
owns the private transport-state path, normalizes `source_allow`, and omits
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
validated on load, and replaced atomically after each mutation.

The bridge console accepts the one-time key id and PSK from the device console
in either listener mode, so a credential can be enrolled before the switch.
The same operations are available as authenticated API requests. Follow the
[transport enable, credential replacement, and recovery workflow](tcp-transport.md#enable-encryption)
instead of editing the state file.

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
