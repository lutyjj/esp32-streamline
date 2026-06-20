# Security Notes

StreamLine is a single-owner appliance for a trusted home LAN. Mutating HTTP
endpoints require a per-device **console secret** (bearer token); reads are open.
Traffic is plain HTTP, so the token is only as private as the LAN. Keep the device
on a trusted segment; do not expose its HTTP port or setup AP to untrusted networks.

## Attack surface

| Surface | State | Risk |
|---|---|---|
| HTTP writes (`:80`) | Token-gated once provisioned | No token, no control (config, target, reset) |
| HTTP reads (`:80`) | Open; never returns secrets | Status readable, no control |
| Web UI POSTs | Bearer token in a custom header | CSRF-safe; token sniffable on plain HTTP |
| Setup AP | Open; writes open only until a secret is set | Brief window at first commissioning |
| PCM stream (`:39000`) | Cleartext TCP | LAN sniffer can capture audio (#12) |
| Wi-Fi credentials | Plaintext in NVS, write-only via API | Recoverable with physical flash access (out of scope) |
| Bridge WAV (`:8088`) | Unauthenticated | Anyone on the LAN can listen |

The main risk auth closes is **CSRF**: without it, any web page in the owner's
browser could POST `/api/reset` or repoint the stream. A token in a custom
`Authorization` header forces a CORS preflight the device never approves, so
cross-origin requests are blocked. Cookies or Basic Auth would not help —
browsers send those automatically.

## Roadmap

### Tier 0 — API authentication (#6)

- Mutating endpoints (`/api/setup`, `/api/audio`, `/api/reset`) require the secret
  as a bearer token, checked with a constant-time compare (`http::constant_time_eq`).
- Secret is set during commissioning (Console Secret, min 8 chars), stored in NVS,
  write-only. An unprovisioned device accepts setup writes so the first secret can
  be set; after that, every write needs it.
- Web UI keeps the token in `localStorage` and sends it on every request; `401`
  prompts for it. The config schema is versioned, so an incompatible stored config
  triggers re-commissioning instead of booting without a secret.
- Lost secret ⇒ reflash to recover. No remote reset without the token, by design.

### Tier 1 — secure OTA (#7)

OTA is remote code execution, so when it lands it must:

- **Sign images** with the Secure Boot v2 scheme, verified on OTA *without* hardware
  secure boot — cheap, reversible, and a forged image won't boot.
- Require the Tier 0 token and pull over HTTPS (`esp_https_ota` + cert bundle).
- Roll back on failed self-test (`esp_ota_mark_app_valid_cancel_rollback`).
- Add `ota_0`/`ota_1`/`otadata` partitions — confirm the dual-slot layout fits flash
  first (the Rust image is large).

### Tier 2 — transport encryption (#12)

**No on-device TLS. A reverse proxy is expected in front if encryption is needed.**
`esp-idf-svc` can serve HTTPS (`server_certificate`/`private_key`), but the cost is
the certificate, not the code: self-signed means browser warnings or a per-client CA,
per-device keys mean on-device keygen + NVS + mDNS, and mbedTLS adds ~30–50 KB RAM
per session. A reverse proxy with a real cert is strictly better at near-zero device
cost. ESPHome ships the same way (plain-HTTP web server + digest auth, no device TLS).

For the **PCM stream** (#12), the Noise protocol — ESPHome's
`Noise_NNpsk0_25519_ChaChaPoly_SHA256` (32-byte PSK, X25519, ChaCha20-Poly1305) — is
the lead candidate: far lighter than TLS, no certs, reuses a shared secret. It can't
serve the browser console (browsers speak only TLS), which is why the proxy stays the
answer there.

### Out of scope

Physical-theft hardening (Secure Boot, flash/NVS encryption), on-device TLS,
session/cookie logins, and user accounts — all disproportionate for a LAN line-in
streamer.

## Bridge

- Keep ports `39000` and `8088` on a trusted network; never expose them directly.
- Set `--source-allow <ESP32 IPv4>` (or `STREAMLINE_SOURCE_ALLOW`) to reject
  unexpected PCM sources. Not a firewall replacement — restrict inbound at the
  boundary.
- The WAV stream is unauthenticated. Front it with an authenticating proxy before
  sharing beyond a trusted LAN.
</content>
