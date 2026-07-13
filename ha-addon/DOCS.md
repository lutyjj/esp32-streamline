# ESP32 StreamLine Bridge

This add-on runs the StreamLine PCM-to-WAV bridge as a Home Assistant service.
Each ESP32 device sends raw PCM over a direct TCP connection to the Home
Assistant host on port `39000`; the bridge serves the live audio over HTTP
`8088`.

Point each device at the host's LAN IP address, not a reverse-proxy hostname.
The device opens a raw TCP socket that an HTTP reverse proxy does not forward,
so a proxy in front of Home Assistant carries the web UI but never the device's
audio connection.

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
- **Open Web UI** (Home Assistant ingress) — the recording console. On the LAN,
  `http://<home-assistant-host>:8088/` serves the same page.

## Record a source

In the add-on configuration, turn on `recordings_enabled` and set a private
`recording_token` of at least 16 characters. Restart the add-on, open **Open
Web UI** (or the StreamLine sidebar entry), and unlock with that token. Choose
the device source, name the recording, start it, then play the source.

The add-on serves this page through Home Assistant ingress, so it opens on the
same host and port as Home Assistant and works behind a reverse proxy. Port
`8088` stays published for Music Assistant and direct LAN access.

The add-on stores WAV files in its private working directory. They survive
add-on restarts and updates, but Home Assistant backups exclude them to avoid
putting multi-gigabyte captures in routine backups. Restoring or uninstalling
the add-on removes these files. Download every completed WAV you want to keep,
then delete the bridge copy from the recording page.

Recording preserves the analog input as 48 kHz, 16-bit stereo PCM. It is not a
bit-perfect CD extraction and does not split tracks or fetch metadata.

## Restrict sources

Leave `source_allow` blank to accept any LAN source. Set it to a comma-separated
list of ESP32 IPv4 addresses to reject unexpected PCM producers.

The [bridge reference](../docs/bridge.md) defines every add-on tuning option,
its default, and its validation rule.

## Add Home Assistant entities and media

Install the ESP32 StreamLine HACS integration from this repository and restart
Home Assistant. The add-on publishes a Supervisor discovery prompt containing
its internal API address and recording access. Confirm it under **Settings →
Devices & services**.

The integration adds source entities and recording controls. Finalized WAV
files appear under **Media → StreamLine** and play through an authenticated Home
Assistant proxy. [Home Assistant integration](../docs/home-assistant.md) owns
installation, actions, media behavior, and troubleshooting.
