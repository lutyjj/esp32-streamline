# Bridge reference

The bridge accepts cleartext StreamLine PCM on TCP `39000` and authenticated
TLS 1.3 PCM on TCP `39001`. It serves live WAV on HTTP `8088`. It owns producer
authentication, packet playout, source lifecycle, HTTP client fan-out, and an
optional lossless recording store. It does not retain source pipelines across
a restart or identify a device by hostname.

## Endpoints

| Endpoint | Contract |
| --- | --- |
| `/streamline.wav` | Live WAV from the sole source, or a pending pipeline before a producer connects. |
| `/streamline.wav?source=<source>` | Live WAV from an IPv4 cleartext source or authenticated TLS key id. |
| `/status` | Bridge version, per-source playout/client statistics, latest PCM levels, and lifecycle state. |
| `/health` | `200 OK` with `ok` while the HTTP process is running. |
| `/api/openapi.json` | OpenAPI 3.1 contract generated from the running bridge routes and Pydantic models. |
| `/` and `/recordings` | Bridge console with live sources and optional recordings. The Home Assistant add-on serves it through ingress. |
| `/api/recordings/*` | Recording capabilities and authenticated file/session operations. |
| `/api/transport` | Listener state, enrolled key ids, and authentication counters; never PSKs. |
| `/api/transport/keys/<key-id>` | Transport-token authenticated `PUT` and `DELETE` key mutations. |

When more than one source exists, an unqualified `/streamline.wav` request
returns `409` and lists the available source ids. Invalid source values return
`400`; unknown source ids return `404`.

## Source lifecycle

A cleartext source is keyed by its TCP peer IPv4 address. An encrypted source
is keyed by its authenticated device key id; its lifecycle also reports the
peer IPv4 address and `tls-psk` transport. `source_allow` always checks the peer
address. An allowlisted address remains addressable before a cleartext source
connects. A dynamic source is `connected` while its TCP producer is active,
`http-selected` while an HTTP client holds it open, and `disconnected` after
both end. A bare WAV request creates a `pending` dynamic pipeline that the first
producer adopts.

The bridge retains an inactive dynamic source for
`--source-eviction-idle-seconds` (300 seconds by default). A reconnect during
that interval reuses its playout pipeline. An active TCP producer or HTTP
client prevents eviction. The `/status` lifecycle block reports the state,
HTTP client count, current idle duration, and eviction interval.

Each source snapshot also includes `levels`, the peak and RMS absolute sample
values for the latest accepted 16-bit stereo PCM packet. Each channel ranges
from `0` (silence) through `32768` (full scale). The bridge console polls this
open JSON contract once per second and renders the values as a live meter.

The bridge owns [its OpenAPI artifact](bridge-openapi.json). Console checks use
that artifact to generate a typed client; do not edit generated client files.

## Tuning options

| Option | Default | Constraint | Meaning |
| --- | ---: | --- | --- |
| `--cleartext-enabled` | true | boolean | Enable compatibility PCM intake on `--tcp-port`. |
| `--tls-enabled` | false | boolean | Enable authenticated TLS 1.3 PCM intake. |
| `--tcp-port` | 39000 | integer >= 1 | Cleartext PCM listener. Must differ from the TLS port when both are enabled. |
| `--tls-port` | 39001 | integer >= 1 | Encrypted PCM listener. |
| `--tls-keys-file` | empty | path required with TLS | Private versioned device-key map. |
| `--source-allow` | empty | IPv4 addresses | Repeat or comma-separate allowed producer addresses. |
| `--max-sources` | 8 | integer >= 1 | Maximum retained source pipelines. |
| `--max-http-connections` | 32 | integer >= 1 | Maximum simultaneous HTTP workers. Excess connections are rejected. |
| `--http-request-timeout-seconds` | 10.0 | number >= 0.001 | Socket inactivity before an HTTP client is disconnected. |
| `--client-buffer-chunks` | 2048 | integer >= 1 | Per-client output queue depth. Full queues evict the client. |
| `--playout-buffer-seconds` | 1.0 | number >= 0.001 | Packets buffered before playout begins or resumes. |
| `--max-repeat-conceal-packets` | 3 | integer >= 0 | Loss packets that repeat attenuated PCM before silence. |
| `--max-outage-silence-seconds` | 5.0 | number >= 0.001 | Concealed outage before playout re-buffers. |
| `--source-idle-timeout-seconds` | 5.0 | number >= 0.001 | Inactive TCP connection timeout. |
| `--source-eviction-idle-seconds` | 300.0 | number >= 0.001 | Inactive dynamic source retention interval. |

Home Assistant exposes the owner-facing listener and tuning options. Its add-on
adapter owns the private key-file path, normalizes `source_allow`, and omits
settings that the Supervisor did not provide.

## Encrypted devices

Set `STREAMLINE_TRANSPORT_API_TOKEN` to at least 16 private characters and
provide `--tls-keys-file` when TLS is enabled. Compose uses the private
`transport-data` volume at `/data/transport-keys.json`. The Home Assistant
add-on uses its Supervisor-owned `/data` directory. The key file is mode `0600`,
bounded, validated on load, and replaced atomically after each mutation.

The bridge console accepts the one-time key id and PSK from the device console.
The same operation is available as an authenticated API request. Follow the
[transport enable, rotation, recovery, and cleartext-retirement workflow](tcp-transport.md#enable-encryption)
instead of editing the key file.

## Recordings

Recording is disabled unless the deployment supplies writable storage. Set
`--recordings-dir` (or `STREAMLINE_RECORDINGS_DIR`) and a
`STREAMLINE_RECORDING_TOKEN` of at least 16 characters for a standalone
bridge. For Compose, set the directory to `/recordings`; its named volume owns
the files. Home Assistant users enable recordings and set the token in the
add-on options. Open `http://<bridge-host>:8088/` (or `/recordings`) to record,
download, or delete files. Home Assistant opens the same console through the
add-on's ingress Web UI.

[Lossless recordings](recordings.md) defines the user flow, API, resource
limits, timeline reconstruction, and storage lifecycle.
