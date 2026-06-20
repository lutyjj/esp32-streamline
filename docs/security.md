# Security Notes

ESP32 StreamLine is a trusted-LAN appliance. It has **no HTTP API authentication**,
no transport encryption (TLS), and no user accounts. Assume any host that can reach
the device can fully control it. Run it only on a trusted network segment and do not
expose its HTTP port or setup AP to untrusted networks.

## Firmware threat model

- The HTTP API is fully open. Any client that can reach the device can read status
  and change every setting — Wi-Fi credentials, stream target, and audio levels —
  and trigger a configuration reset. There is no authentication yet; it is tracked
  in [issue #6](https://github.com/lutyjj/esp32-streamline/issues/6).
- The setup AP (shown only while the device is unconfigured) is open, so initial
  commissioning needs no pre-shared secret. Finish setup promptly on a trusted
  network.
- Saved Wi-Fi credentials live in ESP32 NVS and are never returned through the API
  — the password field is write-only.
- Captured audio is sent as clear PCM over TCP; it is not encrypted.

Prefer an isolated IoT VLAN with firewall rules limiting which hosts can reach the
device and the bridge.

## Hardening roadmap

The most sensible next step is request authentication (issue #6): provision a
per-device secret and require it on the mutating endpoints (`/api/setup`,
`/api/audio`, `/api/reset`) while leaving reads open. That stops casual tampering
and accidental resets without the cost of on-device TLS, which is impractical to
manage for a LAN appliance. Network isolation remains the primary control; add a
TLS-terminating, authenticating reverse proxy only if the device is ever exposed
beyond a trusted LAN.

## Bridge

- Keep TCP port `39000` and HTTP port `8088` on a trusted network. Do not expose
  them directly to the internet.
- Set `--source-allow <ESP32 IPv4>` or `STREAMLINE_SOURCE_ALLOW=<ESP32 IPv4>` to
  reject unexpected PCM sources. Multiple addresses may be comma-separated.
- Source allowlisting is not a replacement for a firewall. Restrict inbound access
  to the bridge host at the network boundary when possible.
- The HTTP WAV stream is unauthenticated. Put an authenticated reverse proxy in
  front of it before sharing it beyond a trusted LAN.
