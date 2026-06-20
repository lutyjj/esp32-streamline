# Security Notes

ESP32 StreamLine is a single-owner appliance for a trusted home LAN. The mutating
HTTP API requires a per-device **console secret** (a bearer token); status and
config reads are open. There is **no transport encryption (TLS)** and no user
accounts, so the token travels in clear over the LAN. Run the device only on a
trusted network segment and do not expose its HTTP port or setup AP to untrusted
networks.

This document records the threat model and the hardening roadmap. The goal is not
bank-grade security; it is to make a single-owner LAN appliance *as secure as is
reasonable* — stop other LAN devices and drive-by browser attacks from controlling
it, and make firmware updates safe when they land — without gold-plating it.

## Attack surface

| Surface | State | Risk on a home LAN |
|---|---|---|
| HTTP API writes (`:80`) | **Token-gated** once provisioned (`/api/setup`, `/api/audio`, `/api/reset`) | A LAN host without the token cannot repoint the stream, change credentials, or reset |
| HTTP API reads (`:80`) | Open (status, config — never returns secrets) | A LAN host can read status; no control |
| Web UI POSTs | Bearer token in a custom header | CSRF-safe (see below); the token is sniffable on plain HTTP |
| Setup AP | Open (no password); writes open only until a secret is set | Brief window during first commissioning |
| PCM stream (`:39000`) | Cleartext TCP | A LAN sniffer can capture the audio (→ issue #12) |
| Wi-Fi credentials | Plaintext in NVS | Physical flash readout extracts them (→ Tier 3) |
| Bridge WAV (`:8088`) | Unauthenticated | Anyone on the LAN can listen to the line-in |

The least obvious risk closed by token auth is **CSRF**, not network sniffing.
Previously the API accepted simple form POSTs with no auth or origin enforcement, so
a malicious page in the owner's browser could silently `fetch()` `/api/reset` or
repoint the stream without ever being on the LAN. Requiring the token in a custom
`Authorization` header defeats this: a cross-origin request carrying it triggers a
CORS preflight the device never approves.

## Firmware threat model

- The mutating endpoints (`/api/setup`, `/api/audio`, `/api/reset`) require the
  console secret as a bearer token; reads stay open. This closes the LAN-host and
  CSRF control paths ([issue #6](https://github.com/lutyjj/esp32-streamline/issues/6)).
  The token is only as confidential as the LAN, since traffic is plain HTTP.
- The setup AP (shown only while the device is unconfigured) is open, so initial
  commissioning needs no pre-shared secret. An unprovisioned device accepts setup
  writes without a token so a secret can be established; once set, every write
  requires it. Finish setup promptly on a trusted network.
- Losing the console secret means re-commissioning by reflashing — there is no
  remote reset without the token by design.
- Saved Wi-Fi credentials live in ESP32 NVS as plaintext and are never returned
  through the API — the password field is write-only — but they are recoverable by
  anyone with physical flash access.
- Captured audio is sent as clear PCM over TCP; it is not encrypted. Transport
  encryption is tracked in
  [issue #12](https://github.com/lutyjj/esp32-streamline/issues/12).

Prefer an isolated IoT VLAN with firewall rules limiting which hosts can reach the
device and the bridge.

## Hardening roadmap

The work is tiered by value-for-effort. Tier 0 is the active scope of issue #6;
Tiers 1–2 belong to their own issues; Tier 3 is optional and only relevant if the
threat model grows to include physical theft.

### Tier 0 — authenticate the API (issue #6) — implemented

The chosen primitive is a **per-device shared secret sent as a custom request
header** (`Authorization: Bearer <token>`), not HTTP Basic Auth and not a session
cookie. The reasons matter:

- **It is inherently CSRF-safe.** A custom header on a cross-origin request forces
  a CORS preflight; the device sends no `Access-Control-Allow-*`, so the browser
  blocks the real request. Cookie- and Basic-Auth schemes stay CSRF-vulnerable
  because browsers attach those credentials automatically.
- The static web UI keeps the token in `localStorage` and attaches it to every
  `fetch()`. The UI renders no user-generated content, so the usual "localStorage
  is XSS-bait" objection barely applies.
- It is a single constant-time comparison in a request guard — small, host-testable,
  and faithful to the project's KISS goals.

What shipped:

- The mutating endpoints (`/api/setup`, `/api/audio`, `/api/reset`) require the
  token; reads stay open. The check is a length-checked constant-time comparison
  (`http::constant_time_eq`) so validation does not leak the secret through timing.
- The secret is provisioned **during commissioning**: a "Console Secret" field on
  the setup form (minimum 8 characters), persisted to NVS alongside the Wi-Fi
  credentials and write-only — it is never returned through the API. An
  unprovisioned device (empty secret) accepts setup writes so the first secret can
  be established; thereafter writes require it.
- The web UI stores the token in `localStorage` and attaches it to every request;
  on a `401` it prompts for the console token. A successful commissioning stores the
  entered secret as the active token automatically.
- The config schema version was bumped (1 → 2). A device holding an older config
  treats it as unconfigured and re-commissions rather than booting without a secret.

Not done, deliberately: giving the setup AP a WPA2 password (MAC-derived + printed
to serial) was considered and skipped — it would force serial access just to join
the AP during normal commissioning, a poor trade for closing a brief, physically
proximate window. It remains an option if that window ever matters.

On-device TLS is intentionally **not** part of Tier 0. Over plain HTTP the token is
sniffable by an on-path LAN attacker; that is an accepted risk under the trusted-LAN
assumption, and the token is a per-device value that is cheap to rotate — not a
reused password.

### Tier 1 — secure OTA when it lands (issue #7)

OTA equals remote arbitrary code execution, so it changes the threat model. When
[issue #7](https://github.com/lutyjj/esp32-streamline/issues/7) is implemented it
must include:

- **Signed images.** Use the Secure Boot v2 signature scheme to verify each new app
  *without* enabling hardware secure boot (signed-app verification on OTA). The
  running app's embedded public key validates the next image, so a forged image
  without the private key will not boot. This is the most important OTA control and
  is cheap — no eFuse burns, reversible.
- **Authentication and secure fetch.** The OTA trigger uses the Tier 0 token, and
  the image is pulled over HTTPS (`esp_https_ota` with the x509 certificate bundle)
  when fetched from a remote server such as GitHub releases.
- **Rollback on failure.** Mark a new app valid only after a self-test
  (`esp_ota_mark_app_valid_cancel_rollback`) so a bad flash auto-reverts. Anti-
  rollback (`esp_efuse_check_secure_version`) is optional and burns eFuses.
- **Prerequisite — partition table.** The firmware currently ships a single-app
  layout. OTA requires `ota_0`/`ota_1`/`otadata` partitions, and the dual-slot
  layout must be confirmed to fit the flash before committing (the Rust image is
  large; verify against the board's flash size).

### Tier 2 — transport encryption (issue #12)

[Issue #12](https://github.com/lutyjj/esp32-streamline/issues/12) spikes whether
the device has the RAM and time budget to encrypt the PCM stream. The same trade-off
applies to the HTTP API: on-device TLS (esp-tls / the esp-idf-svc HTTPS server)
costs roughly 30–50 KB of RAM per session plus flash, slows handshakes, and forces
either constant browser certificate warnings (self-signed) or a private CA installed
on every client. For a single-owner LAN box that is poor value.

Recommendation: do not run TLS on the device. If the appliance is ever exposed
beyond a trusted LAN, terminate TLS at a reverse proxy (the bridge host or the
router) instead. Network isolation remains the primary control.

### Tier 3 — physical-theft protection (optional)

Hardware Secure Boot v2 plus flash encryption and NVS encryption protect Wi-Fi
credentials at rest and block firmware swapping on a stolen device. The eFuse burns
are **irreversible**, add real development friction, and risk bricking, so this tier
is only worth enabling if the threat model includes physical theft. For a hobby
home appliance it is documented as advanced and left disabled.

### Out of scope (by design)

On-device TLS with self-signed certificates, a full session/cookie/login system,
and user accounts are all disproportionate to a single-owner LAN device and are
deliberately excluded to keep the firmware small and maintainable.

## Bridge

- Keep TCP port `39000` and HTTP port `8088` on a trusted network. Do not expose
  them directly to the internet.
- Set `--source-allow <ESP32 IPv4>` or `STREAMLINE_SOURCE_ALLOW=<ESP32 IPv4>` to
  reject unexpected PCM sources. Multiple addresses may be comma-separated.
- Source allowlisting is not a replacement for a firewall. Restrict inbound access
  to the bridge host at the network boundary when possible.
- The HTTP WAV stream is unauthenticated. If audio privacy matters, gate it with the
  same shared secret as the firmware, or put an authenticated reverse proxy in front
  of it before sharing it beyond a trusted LAN.
</content>
</invoke>
