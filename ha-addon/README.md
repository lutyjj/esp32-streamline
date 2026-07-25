# ESP32 StreamLine Bridge add-on

This add-on runs the StreamLine bridge inside Home Assistant OS or Home
Assistant Supervised. It accepts ESP32 PCM on TCP `39000` in one configured
mode—cleartext or authenticated TLS 1.3—and publishes live WAV, status, and
health on HTTP `8088`.

## Install

Add `https://github.com/lutyjj/esp32-streamline` as a Home Assistant add-on
repository, then install **ESP32 StreamLine Bridge**.

## Configure

`source_allow` is optional. Leave it blank to accept any LAN source, or enter a
comma-separated list of ESP32 IPv4 addresses to admit. The
[bridge reference](../docs/bridge.md) owns the option defaults, constraints,
and source lifecycle contract.

Set a private `api_token` of at least 16 characters once; it unlocks every
bridge control in the Web UI — encryption and recordings.

Set `recordings_enabled` to enable lossless WAV recording. The add-on stores
files in its private working directory and exposes the recording flow in its
Web UI. Recordings survive restarts and updates, but backups exclude them and
a restore or uninstall removes them. Download every completed WAV you want to
keep.

To encrypt PCM, generate the device's one-time bridge credential, add it in
the Web UI, switch the bridge to encrypted mode there, then verify and
activate on the device. The coordinated switch briefly interrupts audio. The
[PCM transport workflow](../docs/tcp-transport.md#enable-encryption) owns
cutover, credential replacement, and recovery.

## Confinement

The Supervisor loads `apparmor.txt` under the add-on slug and confines the
bridge to it. The profile lets the bridge run the bundled Python interpreter,
write `/data` and `/tmp`, and open TCP sockets; it denies everything else,
including host namespaces, privileged capabilities, and the Supervisor API.
Home Assistant rates the add-on 8 of 8.

## Use

Point each ESP32 device at the Home Assistant host on port `39000`. Music
Assistant plays the stream as a radio URL: add
`http://<home-assistant-host>:8088/streamline.wav`, with audio already playing on
the source. Snapcast, Icecast, or any HTTP consumer reads the same URL.

With several ESP32 sources, select one with
`http://<home-assistant-host>:8088/streamline.wav?source=<source-id>`.
