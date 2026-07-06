# ESP32 StreamLine Bridge add-on

This add-on runs the StreamLine bridge inside Home Assistant OS or Home
Assistant Supervised. It accepts ESP32 PCM packets on TCP `39000` and publishes
the live WAV stream, status API, and health check on HTTP `8088`.

## Configure

`source_allow` is optional. Leave it blank to accept any LAN source, or enter a
comma-separated list of ESP32 IPv4 addresses to admit.

The remaining options match the bridge command-line tuning flags:

- `max_sources`
- `client_buffer_chunks`
- `playout_buffer_seconds`
- `max_repeat_conceal_packets`
- `max_outage_silence_seconds`
- `source_idle_timeout_seconds`

## Use

Set each ESP32 device's bridge host to the Home Assistant host and bridge port
`39000`. Add `http://<home-assistant-host>:8088/streamline.wav` to Music
Assistant, Snapcast, Icecast, or another HTTP stream consumer.

With multiple ESP32 sources, use
`http://<home-assistant-host>:8088/streamline.wav?source=<esp32-ip>`.
