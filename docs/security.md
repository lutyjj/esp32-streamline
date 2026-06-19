# Security Notes

ESP32 StreamLine is intended for a trusted local network. It does not provide TLS,
user accounts, or encrypted audio transport.

## Firmware

- The setup AP is open so an unconfigured device can be commissioned without a
  pre-shared password. Use it only on a trusted network and finish setup promptly.
- A configured device does not expose its web console by default. Enter `web` over
  serial to enable the read-only status console.
- Configuration writes are accepted only while the device is in setup AP mode.
  Enter `setup` over serial to return to that mode.
- The firmware stores Wi-Fi credentials in ESP32 NVS. It never returns the saved
  password through its HTTP API.

## Bridge

- Keep TCP port `39000` and HTTP port `8088` on a trusted network. Do not expose
  them directly to the internet.
- Set `--source-allow <ESP32 IPv4>` or `STREAMLINE_SOURCE_ALLOW=<ESP32 IPv4>` to
  reject unexpected PCM sources. Multiple addresses may be comma-separated.
- Source allowlisting is not a replacement for a firewall. Restrict inbound access
  to the bridge host at the network boundary when possible.
- The HTTP WAV stream is unauthenticated. Put an authenticated reverse proxy in
  front of it before sharing it beyond a trusted LAN.
