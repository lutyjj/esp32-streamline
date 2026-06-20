# Security Notes

StreamLine is a single-owner appliance for a trusted home LAN. Mutating HTTP
endpoints require a per-device **console secret** (bearer token); reads are open.
Traffic is plain HTTP, so the token is only as private as the LAN. Keep the device
on a trusted segment; do not expose its HTTP port or setup AP to untrusted networks.

This file is the current security posture: the attack surface, the controls in
place, and the standing items we track or have accepted.

## Attack surface

| Surface | State | Risk |
|---|---|---|
| HTTP writes (`:80`) | Token-gated once provisioned | No token, no control (config, target, reset) |
| HTTP reads (`:80`) | Open; never returns secrets | Status readable, no control |
| Setup AP | Open; writes open only until a secret is set | Brief window at first commissioning |
| PCM stream (`:39000`) | Cleartext TCP | LAN sniffer can capture audio |
| Wi-Fi credentials | Plaintext in NVS, write-only via API | Recoverable with physical flash access |
| Bridge WAV (`:8088`) | Unauthenticated | Anyone on the LAN can listen |

## Authentication

- Mutating endpoints (`/api/setup`, `/api/audio`, `/api/reset`) require the console
  secret as a bearer token, checked with a constant-time compare. Reads are open and
  never return secrets.
- The token rides in a custom `Authorization` header, not a cookie or Basic Auth, so
  the API is CSRF-safe: a cross-origin request triggers a CORS preflight the device
  never approves. Cookies/Basic Auth would be sent by the browser automatically.
- The secret is set at commissioning (Console Secret, min 8 chars) and stored
  write-only in NVS. An unprovisioned device accepts setup writes until the first
  secret is set; after that every write requires it.
- The web UI keeps the token in `localStorage`; a `401` prompts for it. A lost
  secret means reflashing to recover — there is no remote reset without the token.

## Tracked items

| Item | Tracking | Notes |
|---|---|---|
| PCM stream is unencrypted | [#12](https://github.com/lutyjj/esp32-streamline/issues/12) | Noise PSK (`Noise_NNpsk0_25519_ChaChaPoly_SHA256`) is the lead — lighter than TLS, no certs, reuses a shared secret. |
| No signed firmware updates | [#7](https://github.com/lutyjj/esp32-streamline/issues/7) | OTA must verify signed images (Secure Boot v2 scheme, no hardware secure boot), be token-gated, pull over HTTPS, and roll back on a failed self-test; needs `ota_0`/`ota_1`/`otadata` partitions that fit flash. |
| Console token travels over plain HTTP | by design | No on-device TLS — the cost is the certificate, not the code. Terminate TLS at a reverse proxy with a real cert if ever exposed beyond the LAN. |
| Wi-Fi credentials stored plaintext in NVS | by design | Reachable only with physical flash access; out of scope for a LAN line-in streamer. |
| Open setup AP during commissioning | by design | Accepts writes only until the first secret is set — a brief, physically proximate window. |
| Bridge WAV stream is unauthenticated | by design | Front it with an authenticating reverse proxy before sharing beyond a trusted LAN. |

## Bridge

- Keep ports `39000` and `8088` on a trusted network; never expose them directly.
- Set `--source-allow <ESP32 IPv4>` (or `STREAMLINE_SOURCE_ALLOW`) to reject
  unexpected PCM sources. Not a firewall replacement — restrict inbound at the
  boundary.
</content>
