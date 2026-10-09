# Pipeline telemetry experiment

The target stack is OpenTelemetry in the firmware and bridge, OTLP over
HTTP/protobuf, and an external OpenTelemetry Collector. Each component owns
its instrumentation and SDK lifecycle. The Collector routes signals to a
backend or writes standard OTLP files for offline inspection.

The opt-in experiment measures device packet construction through sending,
bridge buffer residence, and the first PCM submission to ASGI. It establishes
SDK feasibility and local timing boundaries. It does not measure analog
capture latency, one-way network delay, or sound at a speaker.

## Stack and ownership

| Responsibility | Owner |
|---|---|
| Span lifecycle, identifiers, attributes, sampling and OTLP encoding | Official Rust and Python OpenTelemetry libraries |
| ESP32 HTTP requests | ESP-IDF through the Rust exporter's `HttpClient` interface |
| Audio timing boundaries and bounded admission | The component that performs the measured operation |
| Domain semantic conventions | [Shared registry](../tools/telemetry/registry/packet.yaml), validated by OTel Weaver |
| Resource and SDK conventions | The registry's pinned upstream OpenTelemetry dependency |
| Routing and offline files | Standard Collector receivers and exporters |
| Configuration and health | Component APIs; OpenAPI remains their contract |
| Storage and visualization | Operator-selected backends |

The SDKs derive their OTLP representations from the upstream protocol. There
is no StreamLine span serialization format or duplicated Rust/Python DTO.
Weaver checks the shared attribute vocabulary against emitted telemetry.
The experiment has only one domain attribute; code generation for a larger
instrumentation catalog belongs to Weaver, not a handwritten generator.

Firmware and bridge compile independently and communicate through explicit
wire contracts. Neither imports the other's implementation or requires a
running Collector to build or operate. Their dependency locks stay local.
The existing embedded-console build dependencies remain explicit. The
developer collection tools own their container pins under
`tools/telemetry/`; product images do not inherit a local shared base image.
These boundaries also give a future Bazel graph explicit inputs and outputs.

## Why this stack

[OTLP](https://opentelemetry.io/docs/specs/otlp/) supplies a common protocol
for traces, metrics and logs. The official Rust exporter accepts a native
HTTP client, so firmware can reuse ESP-IDF without a second TLS stack,
Tokio, gRPC or handwritten protobuf encoding. The Python exporter uses its
standard bounded batch processor.

The Rust SDK is the first choice because firmware already uses Rust with
ESP-IDF and `std`. Arduino-oriented embedded OTel libraries add a framework
and FFI boundary without removing the need to prove memory use. Raw
protobuf export would remove SDK policy at the cost of owning identifiers,
resources, lifecycle, errors and aggregation. A proprietary trace backend
would narrow downstream tooling. Reconsider these alternatives only if the
official SDK cannot meet measured device budgets.

Prometheus can remain a metrics backend. Convergence means one application
telemetry model and export protocol, not one storage engine for every signal.
The [Collector](https://opentelemetry.io/docs/collector/) can serve backend
formats at the deployment boundary. The experiment leaves the existing
device Prometheus endpoint intact. Removing it requires metric parity,
device memory measurements and an explicit deployment cutover; traces alone
do not replace counters or histograms.

## What the experiment measures

| Span | Start | End |
|---|---|---|
| `streamline.device.packet` | PCM or silence packet object construction | Sender batch attempt returns |
| `streamline.bridge.playout` | Packet admitted to the buffer | Packet removed for playout |
| `streamline.bridge.first_pcm_submit` | HTTP response streaming begins | First PCM ASGI body send returns |

The device's `send.begin` event separates queue and batching residence from
the send attempt. A successful send means the local transport accepted the
batch; it is not proof of bridge receipt. Failed attempts carry error status
and include the sender's failure backoff. They must be excluded from
successful-delivery latency distributions.

The first-PCM submission span excludes the WAV header and includes silence.
A thin adapter observes the ASGI send call after it returns. This boundary
measures application submission, not socket delivery: an ASGI server can
return without writing when a connection has already closed. Raised write
errors or cancellation before completion end the span with error status.
The span excludes request parsing, downstream playback and speaker delay.
Use a receiving-client observation to prove PCM delivery; this probe cannot
supply that guarantee.

Both packet probes sample every 257th sequence position. This visits every
position in the four-packet sender batch. It is a diagnostic sample, not an
unsampled performance histogram. Lost or reset samples cannot silently
count as successful delivery. Quantiles need the observation count, window,
sample policy, error exclusions and workload beside them.

Each duration uses one monotonic clock. A wall-clock anchor gives the span
its OTLP timestamp; subsequent wall-clock adjustments do not change that
duration. Device and bridge spans are independent traces. Sequence numbers
wrap and reset, so they are not globally unique trace identifiers.

## Resource and failure policy

The firmware feature is `otel-poc`. Capture and sending use timestamps and
a bounded four-observation channel; they do not construct SDK spans or
perform telemetry I/O. A low-priority worker owns the SDK and native HTTP
client. Congestion discards telemetry rather than waiting in the audio
task. The worker reports discarded observations in device logs.

The worker reserves a 12 KiB stack and reports its minimum unused stack.
Native HTTP operations use a 500 ms timeout and a response size limit.
The experiment uses an explicit trusted-LAN HTTP endpoint. Authenticated
HTTPS telemetry, adversarial collectors and long-duration resource behavior
are separate acceptance gates; encrypted PCM does not encrypt OTLP traffic.
The firmware does not require PSRAM.

The bridge retains at most eight active packet samples per source and uses
a 128-span export queue. Source reset and close finish retained samples.
The Collector file exporter rotates its output. Telemetry contains timing
and sequence metadata, not PCM, credentials, Wi-Fi names or transport keys.

The `telemetry` Cargo profile isolates size-oriented optimization from the
normal release profile. Every candidate still passes the physical OTA slot
and reserve-margin gate. A successful cross-build is insufficient evidence
for heap, Wi-Fi, TLS coexistence or OTA recovery.

## Completing the pipeline

Production instrumentation needs these additional contracts:

1. Define the audio unit being followed: a boot/session identity and sample
   range, including intentional silence, capture loss and concealment.
2. Carry sampled [W3C trace context](https://www.w3.org/TR/trace-context/)
   across the PCM boundary and retain that context through playout and each
   client queue. Use SDK propagators, not a new identifier codec. Choose an
   explicit protocol revision with conformance vectors for its carrier.
3. Measure capture completion, queue admission, send, receive, playout and
   HTTP write completion for that same audio unit. Per-client spans branch
   from the shared packet context. Never add stage p99 values.
4. Define startup triggers separately: stream enable, source onset and HTTP
   client admission have different first-delivery paths. Report PCM delivery
   as such; do not label silence delivery as first sound.
5. Establish clock-offset uncertainty before reporting one-way network or
   cross-host age. SNTP wall-clock availability alone is insufficient. Keep
   local durations usable when cross-host alignment is unavailable.
6. Add OTel counters and histograms with seconds as the duration unit and
   bounded stage/outcome attributes. Existing counter owners supply
   observations; do not maintain a second set of stream counters. Keep
   packet, trace and client identifiers out of metric labels.
7. Add API-owned enablement, endpoint policy, resource limits and observable
   export failures. Prove collector outage/recovery, concurrent management,
   OTA, heap margin and sustained encrypted streaming before default use.

The [developer procedure](../tools/telemetry/README.md) owns build and capture
commands. Raw hardware captures and investigation notes stay private.
