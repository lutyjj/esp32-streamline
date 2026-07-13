# ESP32 StreamLine Bridge add-on

This add-on runs the StreamLine bridge inside Home Assistant OS or Home
Assistant Supervised. It accepts ESP32 PCM packets on TCP `39000` and publishes
the live WAV stream, status API, and health check on HTTP `8088`.

## Install

Add `https://github.com/lutyjj/esp32-streamline` as a Home Assistant add-on
repository, then install **ESP32 StreamLine Bridge**.

## Configure

`source_allow` is optional. Leave it blank to accept any LAN source, or enter a
comma-separated list of ESP32 IPv4 addresses to admit. The
[bridge reference](../docs/bridge.md) owns the option defaults, constraints,
and source lifecycle contract.

Set `recordings_enabled` and a private `recording_token` of at least 16
characters to enable lossless WAV recording. The add-on stores files in its
private working directory and exposes the recording flow as its Web UI.
Recordings survive restarts and updates, but backups exclude them and a restore
or uninstall removes them. Download every completed WAV you want to keep.

## Use

Point each ESP32 device at the Home Assistant host on port `39000`. Music
Assistant plays the stream as a radio URL: add
`http://<home-assistant-host>:8088/streamline.wav`, with audio already playing on
the source. Snapcast, Icecast, or any HTTP consumer reads the same URL.

With several ESP32 sources, select one with
`http://<home-assistant-host>:8088/streamline.wav?source=<esp32-ip>`.

The optional [Home Assistant integration](../docs/home-assistant.md) adds
per-source entities and recording control over this add-on's API.
