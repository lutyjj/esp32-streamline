# ESP32 StreamLine Bridge

This add-on runs the StreamLine PCM-to-WAV bridge as a Home Assistant service.
Each ESP32 device sends PCM over a direct TCP connection to the Home Assistant
host. Port `39000` accepts cleartext or authenticated TLS 1.3; the mode is
switched in the bridge's own Web UI and the two modes are mutually exclusive.
The bridge serves live audio over HTTP `8088`.

One add-on option unlocks every bridge control: set a private `api_token` of
at least 16 characters, restart the add-on once, and use that token to unlock
the Web UI. Encryption and recordings both need it.

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
- `http://<home-assistant-host>:8088/streamline.wav?source=<source-id>` — one
  IPv4 cleartext source or authenticated key id when several devices feed the
  bridge.
- `http://<home-assistant-host>:8088/status` — per-source JSON stats.
- **Open Web UI** (Home Assistant ingress) — the recording console. On the LAN,
  `http://<home-assistant-host>:8088/` serves the same page.

## Encrypt a device

1. Generate the one-time bridge credential in the device's **Stream target**
   card and copy it.
2. Open **Open Web UI**, unlock with `api_token`, and add the one-time key id
   and PSK under **Device credentials**. Audio keeps streaming.
3. In the Web UI's **PCM transport** section, switch on encrypted mode.
   Cleartext stops immediately.
4. Verify and activate encryption from the device console. Audio resumes over
   TLS.

[PCM transport workflow](../docs/tcp-transport.md#enable-encryption) covers
credential replacement, rollback, recovery, API equivalents, and the expected
coordinated interruption. If several devices use one add-on, switch them
together.

## Record a source

In the add-on configuration, turn on `recordings_enabled` (it requires
`api_token`). Restart the add-on, open **Open Web UI** (or the StreamLine
sidebar entry), and unlock with the token. Choose the device source, name the
recording, start it, then play the source.

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
list of ESP32 IPv4 addresses to reject unexpected PCM peers. Encrypted source
identity still comes from its authenticated key id.

The [bridge reference](../docs/bridge.md) defines every add-on tuning option,
its default, and its validation rule.
