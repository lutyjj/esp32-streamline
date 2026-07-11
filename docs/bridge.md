# Bridge reference

The bridge accepts StreamLine PCM on TCP `39000` and serves live WAV on HTTP
`8088`. It owns packet playout, source lifecycle, and HTTP client fan-out. It
does not encode audio, retain sources across a restart, or identify a device by
hostname.

## Endpoints

| Endpoint | Contract |
| --- | --- |
| `/streamline.wav` | Live WAV from the sole source, or a pending pipeline before a producer connects. |
| `/streamline.wav?source=<ipv4>` | Live WAV from an existing or allowlisted source. |
| `/status` | Bridge version, per-source playout/client statistics, and lifecycle state. |
| `/health` | `200 OK` with `ok` while the HTTP process is running. |

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

## Tuning options

| Option | Default | Constraint | Meaning |
| --- | ---: | --- | --- |
| `--source-allow` | empty | IPv4 addresses | Repeat or comma-separate allowed producer addresses. |
| `--max-sources` | 8 | integer >= 1 | Maximum retained source pipelines. |
| `--client-buffer-chunks` | 2048 | integer >= 1 | Per-client output queue depth. Full queues evict the client. |
| `--playout-buffer-seconds` | 1.0 | number >= 0.001 | Packets buffered before playout begins or resumes. |
| `--max-repeat-conceal-packets` | 3 | integer >= 0 | Loss packets that repeat attenuated PCM before silence. |
| `--max-outage-silence-seconds` | 5.0 | number >= 0.001 | Concealed outage before playout re-buffers. |
| `--source-idle-timeout-seconds` | 5.0 | number >= 0.001 | Inactive TCP connection timeout. |
| `--source-eviction-idle-seconds` | 300.0 | number >= 0.001 | Inactive dynamic source retention interval. |

Home Assistant exposes the same tuning options. Its add-on adapter normalizes
`source_allow` before passing it to the bridge and omits settings that the
Supervisor did not provide.
