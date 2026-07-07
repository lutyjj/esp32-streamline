# ESP32 StreamLine Bridge add-on

This add-on runs the StreamLine bridge inside Home Assistant OS or Home
Assistant Supervised. It accepts ESP32 PCM packets on TCP `39000` and publishes
the live WAV stream, status API, and health check on HTTP `8088`.

## Install

Add `https://github.com/lutyjj/esp32-streamline` as a Home Assistant add-on
repository, then install **ESP32 StreamLine Bridge**.

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

Point each ESP32 device at the Home Assistant host on port `39000`. Music
Assistant plays the stream as a radio URL: add
`http://<home-assistant-host>:8088/streamline.wav`, with audio already playing on
the source. Snapcast, Icecast, or any HTTP consumer reads the same URL.

With several ESP32 sources, select one with
`http://<home-assistant-host>:8088/streamline.wav?source=<esp32-ip>`.
