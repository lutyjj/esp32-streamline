# Bridge reference

The bridge accepts StreamLine PCM on TCP `39000` and serves live WAV on HTTP
`8088`. It owns packet playout, source lifecycle, HTTP client fan-out, and an
optional lossless recording store. It does not retain source pipelines across
a restart or identify a device by hostname.

## Endpoints

| Endpoint | Contract |
| --- | --- |
| `/streamline.wav` | Live WAV from the sole source, or a pending pipeline before a producer connects. |
| `/streamline.wav?source=<ipv4>` | Live WAV from an existing or allowlisted source. |
| `/status` | Bridge version, per-source playout/client statistics, latest PCM levels, and lifecycle state. |
| `/health` | `200 OK` with `ok` while the HTTP process is running. |
| `/` and `/recordings` | Bridge console with live sources and optional recordings. The Home Assistant add-on serves it through ingress. |
| `/api/recordings/*` | Recording capabilities and authenticated file/session operations. |

When more than one source exists, an unqualified `/streamline.wav` request
returns `409` and lists the available source addresses. Invalid source values
return `400`; unknown source addresses return `404`.

## Source lifecycle

A source is keyed by its TCP peer IPv4 address. An allowlisted address remains
addressable before it connects. A dynamic source is `connected` while its TCP
producer is active, `http-selected` while an HTTP client holds it open, and
`disconnected` after both end. A bare WAV request creates a `pending` dynamic
pipeline that the first producer adopts.

The bridge retains an inactive dynamic source for
`--source-eviction-idle-seconds` (300 seconds by default). A reconnect during
that interval reuses its playout pipeline. An active TCP producer or HTTP
client prevents eviction. The `/status` lifecycle block reports the state,
HTTP client count, current idle duration, and eviction interval.

Each source snapshot also includes `levels`, the peak and RMS absolute sample
values for the latest accepted 16-bit stereo PCM packet. Each channel ranges
from `0` (silence) through `32768` (full scale). The bridge console polls this
open JSON contract once per second and renders the values as a live meter.

## Tuning options

| Option | Default | Constraint | Meaning |
| --- | ---: | --- | --- |
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

Home Assistant exposes the same tuning options. Its add-on adapter normalizes
`source_allow` before passing it to the bridge and omits settings that the
Supervisor did not provide.

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
