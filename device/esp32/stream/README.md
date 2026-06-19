# Stream Firmware

Purpose: capture ES8388 line input and send raw stereo PCM over a persistent TCP
connection to a bridge on the LAN.

## Configuration

The firmware has a setup console and an optional read-only status console backed by
JSON endpoints.

If no saved config exists, or Wi-Fi connection fails, the ESP32 starts an open setup
AP:

```text
SSID: esp32-streamline-XXXX
URL:  http://192.168.4.1/
```

The UI is split into:

- Status: live stream, Wi-Fi, and clipping telemetry
- Setup: Wi-Fi and TCP target settings
- Advanced: ES8388 input line, input gain, and ADC attenuation

When connected to your LAN, the status console is off by default. Enter `web` over
serial to enable it. Configuration changes remain disabled outside setup mode.

For CD line-level input on the tested ESP32 Audio Kit v2.2 / ES8388 board, input
gain `0` avoids clipping. Higher gain values can be useful for weaker sources.

The default input line is `2`. ES8388 Audio Kit v2.2 boards commonly route the
physical line-in jack to the second ES8388 input pair, and some revisions have
known line/mic routing quirks. If audio is missing or tonally wrong, try input
line `1` and `2` from the config page and reboot between changes.

The default ADC attenuation is `0` dB. If `/api/status` shows clipped samples
while the input line and stereo image are correct, try `6` dB and re-measure. This
sets the ES8388 ADC digital volume after codec init; if clipping happens before
that digital stage, use analog attenuation before the board input.

The status page exposes live clipping diagnostics:

```text
peak_abs_current
peak_abs_last_report
peak_abs_lifetime
clipped_samples_current
clipped_samples_last_report
clipped_samples_total
```

The API surface is:

```sh
curl http://<esp32-ip>/api/status
curl http://<esp32-ip>/api/config
curl -X POST --data 'ssid=...' --data 'password=...' --data 'target_host=...' --data 'target_port=39000' http://192.168.4.1/api/setup
curl -X POST --data 'atten=6' http://192.168.4.1/api/audio
curl -X POST http://192.168.4.1/api/reset
```

The write endpoints are available only in setup AP mode. The `/api/audio` endpoint
accepts any subset of `line`, `gain`, and `atten`, saves the updated audio settings,
and reboots.

### Serial commands

The serial monitor (115200 baud) accepts a few runtime commands:

```text
diag   toggle diagnostics mode (per-packet send/blocked timing, EAGAIN counts)
web    toggle the web server in streaming mode (takes full effect after reboot)
setup  start the setup AP with the current configuration
status print a one-line status summary
help   list commands
```

Diagnostics and the web server flag are persisted to NVS and survive reboot. Build
a permanently-on diagnostic image with `-D STREAMLINE_DIAGNOSTICS=1`, or opt in to
the normal-mode status console with `-D STREAMLINE_WEB_SERVER=1`.

### Compile-time defaults

You can still provide compile-time defaults for development:

```sh
cp device/esp32/stream/src/local_config.example.h device/esp32/stream/src/local_config.h
```

Edit `local_config.h`:

```cpp
#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"
#define STREAMLINE_TARGET_HOST "192.168.1.10"
#define STREAMLINE_TARGET_PORT 39000
```

`local_config.h` is ignored by Git. Saved HTTP config takes precedence over these
defaults.

Build:

```sh
make stream
```

Flash:

```sh
make flash PROJECT=stream
```

Serial output will show either the setup AP URL or the LAN config URL.

Run the HTTP bridge:

```sh
python3 bridge/http-wav/server.py
```

With the bridge running, set the TCP target host to the machine running the bridge
and port `39000`. The live stream URL is:

```text
http://<bridge-host>:8088/streamline.wav
```

For local playback on a machine with `ffplay`, point it at the bridge's WAV stream:

```sh
ffplay http://<bridge-host>:8088/streamline.wav
```
