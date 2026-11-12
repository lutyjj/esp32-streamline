# Pipeline telemetry

StreamLine uses OpenTelemetry traces to follow sampled audio from device capture
completion through bridge playout and HTTP submission. Diagnostic sessions are
disabled by default and expire automatically. They expose local stage durations
and causal relationships, not speaker latency or a synchronized one-way network
measurement.

## Stack and ownership

| Responsibility | Owner |
|---|---|
| Span lifecycle, IDs, context and OTLP protobuf | Official Rust and Python OpenTelemetry SDKs |
| Device HTTP and TLS | ESP-IDF through the Rust exporter's HTTP client interface |
| Timing boundaries and admission limits | The component performing the operation |
| Domain names and sampling interval | [Weaver registry and templates](../tools/telemetry/) |
| Session request and status models | Rust types, generated [OpenAPI](telemetry-api.json) and Python models |
| Timing histograms, routing and offline files | Standard OpenTelemetry Collector components |
| Storage and visualization | Operator-selected OTLP backends |

Each component owns its dependency locks and builds independently. Generated
contracts are checked in beside their consumers; building the bridge does not
run Rust or Weaver. `make tools-telemetry-code` refreshes vocabulary constants;
`make firmware-openapi bridge-telemetry-models` refreshes session models. CI
checks both for drift. These explicit inputs also suit a Bazel build graph.

The official Rust exporter accepts a native HTTP adapter, avoiding another TLS
stack, Tokio, gRPC, handwritten identifiers or a custom protobuf encoder.
The device uses a bounded SDK span processor because the native Rust batch
processor panics if its worker cannot start. StreamLine reserves its worker
fallibly before publishing a session. The bridge uses the native batch processor.

Existing Prometheus counters remain the unsampled source for audio reliability.
The Collector's `span_metrics` connector derives diagnostic duration histograms
from traces, so the device needs no second metrics SDK or export worker. Histograms
use seconds and bounded stage/outcome dimensions. Packet and trace IDs stay out
of metric labels; exemplars link histogram observations to traces.

## Session API

Both components expose authenticated `GET /api/telemetry`,
`POST /api/telemetry/start` and `POST /api/telemetry/stop`. The device accepts form
fields with its normal digest authentication; the bridge accepts JSON with its
configured bearer token. The [collection procedure](../tools/telemetry/README.md)
provides examples.

A start request supplies a complete OTLP HTTP/protobuf traces `endpoint` ending
in `/v1/traces` and `duration_seconds` between 30 and 3,600. Optional
`bearer_token` and `ca_certificate_pem` configure HTTPS authentication and trust.
Credential-free HTTP requires `allow_insecure=true` and a trusted LAN. URLs
cannot contain credentials, fragments or queries. Redirects are disabled.
Encrypted PCM and encrypted OTLP are separate connections.

Sessions are volatile and do not survive restart. State progresses from
`disabled` to `running`, then `stopping` and `finished`. Stop returns without
waiting for network I/O. A new session is accepted only after its predecessor
finishes. Export work can outlast the sampling deadline while a native network
operation completes. Device firmware maintenance and active telemetry sessions
are mutually exclusive; stop telemetry and wait for `finished` before OTA.

Status exposes SDK-ended spans, exporter-reported successes, failed spans,
export failures, pending spans and discarded spans. These are diagnostics about
export attempts, not acknowledgments of durable backend storage. On the bridge,
pending includes SDK queue losses until shutdown; final discarded count reconciles
ended spans against successes and failures. In-flight packet spans are not yet
ended spans. Status never returns the endpoint, token or trust certificate.
`wall_clock_ready` reports timestamp readiness; `cross_host_clock_aligned` remains
false because clock-offset uncertainty is not measured.

## Measurement boundaries

| Span | Start | End |
|---|---|---|
| `streamline.device.packet` | Completed capture read | Sender batch attempt returns |
| `streamline.device.queue` | Queue admission | Sender batch starts |
| `streamline.device.send` | Sender batch starts | Local transport write attempt returns |
| `streamline.bridge.playout` | Complete packet admitted | Packet removed for playout |
| `streamline.bridge.client_submit` | Client queue admission | PCM ASGI send returns |
| `streamline.bridge.first_pcm_submit` | HTTP response streaming starts | First PCM ASGI send returns |

The [PCM protocol](pcm-protocol.md) carries SDK-generated W3C `traceparent` for
sampled packets. Per-client spans branch from the shared playout context.
Discarded queued packets, source resets, and cancelled submissions end their
retained spans with error status. A successful device write proves local
transport acceptance. ASGI send completion proves application submission; the
server can return after a peer disconnect without delivering those bytes.
Neither boundary proves downstream playback.

Periodic sampling visits every 257th capture sequence, covering all positions
in four-packet sender batches. Device session start, stream enable and detected
source onset also trigger samples. `streamline.trigger` distinguishes these on
the device packet span. `streamline.packet.kind` distinguishes audio from gated
silence. Source onset starts at signal-gate detection, not the first analog sample.
HTTP first-PCM submission includes silence and excludes the WAV header and request
parsing. It must not be called time to first sound.

Durations use a monotonic clock anchored to wall time. Wall-clock adjustments
do not change a local span's duration. Cross-host context correlates packets but
does not establish clock synchronization. Do not subtract device and bridge
wall timestamps to claim network delay, sum stage percentiles, or treat sampled
histograms as full-population latency guarantees. Report sample count, window,
workload, sampling trigger and error exclusions beside every quantile.

## Resource and failure policy

The device retains an eight-span export queue and exports at most four spans per
batch from a 12 KiB low-priority worker. Capture and sender tasks construct sampled
SDK spans but never perform export I/O or wait for export queue capacity. Queue
pressure discards telemetry. Sample metadata is allocated only for sampled audio
packets. Unsampled packets retain their base wire size.

Admission checks internal heap, including the largest block, without relying on
PSRAM. HTTP requires 48 KiB free and HTTPS requires 96 KiB, both with a 16 KiB
contiguous block. Each export rechecks headroom after SDK encoding and fails the
diagnostic batch if memory is insufficient. HTTPS can be unavailable on a small
ESP32 even when HTTP tracing and encrypted PCM fit. Use explicitly enabled
trusted-LAN HTTP collection in that case; keep PCM encryption enabled.
Native HTTP operations have a 500 ms timeout, bounded request
and response bodies, and no application retry loop. These are operation bounds,
not a hard deadline for all DNS, handshake and header processing. Audio does not
wait for a collector to recover. Every image must pass the OTA slot reserve gate.

The bridge retains at most eight active packet samples per source, uses a
128-span export queue, and finishes client samples when their queue is closed.
Its exporter accepts at most 4 KiB of response data and requires identity response
encoding. It checks a 500 ms body-read budget between native reads. Native DNS,
header parsing and individual reads can outlast that budget; the session stays
`stopping` until an outstanding export releases its connection, even if the SDK's
shutdown wait expires. Another session cannot reserve a worker during that wait.
The Collector bounds memory, metric cardinality and rotating file output.
Exported metadata contains timing and sequence identity, never PCM, credentials,
network names or transport keys. Raw investigations belong in gitignored
`.private/` directories.
