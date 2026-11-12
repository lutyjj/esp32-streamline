# Collect pipeline traces

These tools receive standard OTLP traces and write rotating `traces.jsonl` and
`metrics.jsonl` files. They need no dashboard or changes to a deployed bridge.
[Telemetry contracts](../../docs/telemetry.md) define what the measurements prove.

Start the Collector from the repository root:

```sh
make tools-telemetry-collect
```

The receiver listens on loopback port 4318 and writes to `.private/telemetry/`.
For a device session, set `TELEMETRY_BIND` to the collector host's trusted LAN
address. `TELEMETRY_OUTPUT` selects another absolute output directory. Ctrl-C
stops the disposable container. The supplied receiver uses trusted-LAN HTTP;
use an operator-managed HTTPS Collector for authenticated export.

Start a bounded session on a device running matching firmware and bridge
protocols. Set `DEVICE` and `ADMIN_KEY` in the calling environment:

```sh
curl --digest -u "admin:$ADMIN_KEY" "http://$DEVICE/api/telemetry/start" \
  --data-urlencode endpoint=http://192.0.2.20:4318/v1/traces \
  --data duration_seconds=300 --data allow_insecure=true
```

For the bridge, set `BRIDGE` and `BRIDGE_TOKEN` and start the same interval:

```sh
curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' "http://$BRIDGE/api/telemetry/start" \
  --data '{"endpoint":"http://192.0.2.20:4318/v1/traces","duration_seconds":300,"allow_insecure":true}'
```

Read `GET /api/telemetry` with the same authentication to check state and export
health. `POST /api/telemetry/stop` ends admission; wait for `finished` before
starting another session or installing device firmware. Bridge exporter settings
come from this API; remove `OTEL_EXPORTER_OTLP*` environment variables before
starting a session. Sessions do not change stored device or bridge settings.

Normal release images include tracing, disabled until a session starts. For
hardware validation without an analog source, build with
`make firmware-artifacts FEATURES=test-source VERSION=telemetry-test`.
`test-source` preserves I2S timing while supplying synthetic PCM. Use the
[custom OTA path](../../docs/ota.md#custom-image-installs-development) and restore
a signed normal image after the test.

Copy a completed trace file before validating it with the native file receiver
and Weaver:

```sh
make tools-telemetry-live-check TELEMETRY_INPUT=/absolute/path/traces.jsonl
```

Read Weaver's entity counts as well as its verdict: a run with no received
telemetry proves nothing. Contract violations fail the command. Development
stability advice is expected. Replay uses a disposable Compose network.

For ad hoc inspection, extract span names and approximate durations:

```sh
jq -r '.resourceSpans[].scopeSpans[].spans[] |
  [.name, ((.endTimeUnixNano | tonumber) -
  (.startTimeUnixNano | tonumber)) / 1000000] | @csv' traces.jsonl
```

For exact arithmetic, parse timestamp strings as integers in Python or an
analysis tool with 64-bit integer support. Keep error spans separate and report
sample counts beside quantiles. The OTLP files can also be replayed into a trace
backend through standard Collector exporters; no StreamLine viewer is required.
