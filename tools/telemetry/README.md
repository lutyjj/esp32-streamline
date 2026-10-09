# Collect pipeline traces

These developer tools receive standard OTLP and write rotating JSONL files.
They do not change a Home Assistant deployment or require a dashboard.

Start the Collector from the repository root:

```sh
make tools-telemetry-collect
```

It listens on loopback port 4318 and writes to `.private/telemetry/`.
For a hardware test, set `TELEMETRY_BIND` to the host's trusted LAN address.
Use `TELEMETRY_OUTPUT` to select another absolute output directory. Stop
the foreground process with Ctrl-C; the container is disposable.

Build a signed device experiment with a collector address reachable by the
device:

```sh
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://192.0.2.10:4318/v1/traces
make firmware-artifacts PROFILE=telemetry FEATURES=otel-poc,test-source \
  VERSION=telemetry-poc \
  CONTAINER_EXTRA_FLAGS='-e OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'
```

`test-source` supplies synthetic PCM while preserving I2S timing. Omit it
for normal line-in. The endpoint is compiled into this opt-in experiment;
the normal release has no exporter. Use the documented
[custom OTA path](../../docs/ota.md#custom-image-installs-development), then
restore the original signed normal image after hardware testing.

For the bridge, supply `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
`OTEL_EXPORTER_OTLP_ENDPOINT` in its process environment. With neither set,
the bridge does not start an exporter. Use a disposable bridge for
experiments. [Timing boundaries](../../docs/telemetry.md) define what its
spans prove.

Copy the completed `traces.jsonl` before replaying it. The native Collector
file receiver and Weaver check the copied telemetry:

```sh
make tools-telemetry-live-check TELEMETRY_INPUT=/absolute/path/traces.jsonl
```

Read Weaver's entity counts as well as its verdict: a run with no received
telemetry proves nothing. Development-stability advice is expected for this
experimental registry. Contract violations fail the command. Replay uses
an isolated Compose network and removes its containers afterward.

For ad hoc inspection, extract span names and durations in milliseconds:

```sh
jq -r '.resourceSpans[].scopeSpans[].spans[] |
  [.name, ((.endTimeUnixNano | tonumber) -
  (.startTimeUnixNano | tonumber)) / 1000000] | @csv' traces.jsonl
```

For exact nanosecond arithmetic, parse the timestamp strings as integers
in Python or an analysis tool with 64-bit integer support. Keep error
spans separate and report sample counts alongside quantiles. The same OTLP
files can be replayed into a trace backend through standard Collector
exporters; no StreamLine viewer or conversion format is required.
