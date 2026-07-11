# ESP32 StreamLine Bridge

This add-on runs the StreamLine PCM-to-WAV bridge as a Home Assistant service.
Point each ESP32 device at the Home Assistant host on port `39000`; the bridge
serves the live audio on HTTP `8088`.

## Play it in Music Assistant

Add this URL to Music Assistant as a radio/URL stream:

```text
http://<home-assistant-host>:8088/streamline.wav
```

Start audio on the source before you add the stream. A StreamLine node streams
only while its input plays, so an idle node serves the WAV header with no audio,
and Music Assistant rejects a stream it cannot probe. With audio playing, the URL
validates immediately.

## Endpoints

- `http://<home-assistant-host>:8088/streamline.wav` — live WAV stream.
- `http://<home-assistant-host>:8088/streamline.wav?source=<esp32-ip>` — one
  stream when several ESP32 sources feed the bridge.
- `http://<home-assistant-host>:8088/status` — per-source JSON stats.

## Restrict sources

Leave `source_allow` blank to accept any LAN source. Set it to a comma-separated
list of ESP32 IPv4 addresses to reject unexpected PCM producers.

The [bridge reference](../docs/bridge.md) defines every add-on tuning option,
its default, and its validation rule.
