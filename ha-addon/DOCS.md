# ESP32 StreamLine Bridge

The add-on runs the StreamLine TCP PCM to HTTP WAV bridge as a Home Assistant
service. Configure the ESP32 StreamLine device to send PCM to the Home
Assistant host on port `39000`.

The WAV stream is available at:

```text
http://<home-assistant-host>:8088/streamline.wav
```

The status endpoint is available at:

```text
http://<home-assistant-host>:8088/status
```

For several ESP32 sources, select one stream with:

```text
http://<home-assistant-host>:8088/streamline.wav?source=<esp32-ip>
```

Set `source_allow` to a comma-separated list of ESP32 IPv4 addresses when the
bridge should reject unexpected PCM producers.
