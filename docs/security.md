# Security Notes

StreamLine is a single-owner appliance for a trusted home LAN. Mutating HTTP
endpoints require a per-device **admin key**, proven by RFC 7616 digest
authentication (SHA-256), so the key itself never crosses the network and a
captured exchange authorizes nothing later. Reads are open except the device
log and crash dumps. Traffic is plain HTTP: request and response bodies are
readable in transit. Keep the device on a trusted segment; do not expose its
HTTP port or setup AP to untrusted networks.

This file is the current security posture: the attack surface, the controls in
place, and the standing items we track or have accepted. The posture matches
or exceeds comparable local-control firmware (Shelly's digest model; ESPHome,
Tasmota, and WLED authenticate with cleartext credentials or a PIN) while
staying cloud-free.

## Attack surface

| Surface | State | Risk |
|---|---|---|
| HTTP writes (`:80`) | Digest-authenticated once provisioned; nonce counts kill replay | No key, no control (config, target, reset); capturing traffic yields nothing that authorizes a later write |
| HTTP reads (`:80`) | Open; never returns secrets | Status and metrics readable, no control |
| Device log (`/api/logs`) | Admin-key gated | Owner-only; returns the network name, bridge host, and addresses the firmware logged. Never contains keys — see [diagnostics](diagnostics.md) |
| Crash dump (`/api/coredump`, `/api/coredump/image`) | Admin-key gated | Owner-only; a dump is a copy of task memory at the moment of a panic and can hold anything the firmware held — see [diagnostics](diagnostics.md#crash-dumps) |
| Setup AP | WPA2 with a per-device password minted at first boot; writes open only until an admin key is set | Joining needs the password from the device's serial log, the flasher, or its label, so commissioning is anchored to possession of the board. The password is device identity: no reset changes it, no read API returns it, and the factory-reset response is its only API appearance. A button held at power-on starts the AP open for one boot — the physical-presence fallback for a lost password |
| OTA update (`/api/ota/update`) | Admin-key gated; vendor RSA-3072 signature verified before commit, plus SHA-256 and auto-rollback | Owner-only; only firmware signed by the trusted key installs |
| Custom-image OTA (`/api/ota/update` with `url`+`sha256`) | Admin-key gated; pinned by the admin SHA-256 and verified against the trusted signing key | Owner-only; a forged image is rejected even when its digest matches, so the URL may be plain HTTP |
| PCM stream (`:39000`) | Explicit cleartext TCP or TLS 1.3 PSK mode | Cleartext permits LAN capture and impersonation; TLS authenticates the source and protects audio |
| Wi-Fi credentials | Plaintext in NVS, write-only via API | Recoverable with physical flash access |
| PCM device PSK | Plaintext in NVS, write-only and independently random | Recoverable with physical flash access; never returned by a read API |
| Bridge transport state (mode + key map) | Private `0600` atomic file; mutations gated by the bridge API token | Bridge host access exposes enrolled device keys; a token holder can switch the listener mode or replace keys |
| Bridge WAV (`:8088`) | Unauthenticated | Anyone on the LAN can listen |
| Bridge recording API (`:8088`) | Disabled without writable storage; gated by the bridge API token when enabled | Token holder can record, list, download, and delete captures |
| Bridge recording directory | Dedicated writable volume; link-safe file operations and validated metadata | A storage peer can delete or corrupt recordings, but cannot redirect bridge file access outside the directory |

## Authentication

- Mutating endpoints (`/api/settings/*`, `/api/restart`, `/api/factory-reset`,
  `/api/ota/*`, `/api/transport/*`, `/api/stream`) and the no-op key check
  (`/api/unlock`) require the admin key through **RFC 7616 digest
  authentication**: the device answers an unauthenticated write with a 401
  challenge (`realm="streamline"`, `algorithm=SHA-256`, `qop=auth`), and the
  client proves possession by hashing the key with the challenge nonce, a
  strictly increasing nonce count, and the request's method and URI. The
  device tracks each nonce's count and expires nonces after an hour, so a
  captured exchange cannot be replayed — byte-identical or redirected at a
  different endpoint. Responses are compared constant-time. Standard clients
  need no custom code: `curl --digest -u "admin:$STREAMLINE_ADMIN_KEY"`,
  Python `requests.auth.HTTPDigestAuth`, and the console's own client all
  speak it.
- Reads are open and never return secrets, with two exceptions behind the
  same digest gate: `/api/logs` returns what the firmware logged, which names
  the joined network and the hosts the device reached, and the
  `/api/coredump` reads return a panic's copy of task memory, which can hold
  anything the firmware held. No log line carries a key, password, or PSK.
- Credentials ride in a script-set `Authorization` header, not a cookie, so
  the API is CSRF-safe: a cross-origin request triggers a CORS preflight the
  device never approves, and no browser attaches the digest response
  automatically.
- The key is generated by the browser during commissioning as 24 random bytes
  encoded as hex and stored write-only in NVS. It crosses the wire exactly
  once, over the WPA2-protected setup link; afterwards only digest proofs do.
  An unprovisioned device accepts setup writes until the first key is set;
  after that every write requires it.
- The web UI keeps the key in session storage by default, with explicit opt-in
  browser storage. Unlocking settings lasts 15 minutes. A lost key means
  reflashing to recover — there is no remote reset without the key.

## Control-plane transport

The console and API stay plain HTTP by decision, not omission. A LAN device
cannot serve a certificate a browser trusts: a self-signed certificate warns
on every first visit and trains owners to click through warnings, a
Plex-style public-CA arrangement is a permanent DNS-and-certificate cloud
commitment this cloud-free product refuses, and a local CA is worse UX than
the warning. Every comparable product's local UI (Shelly, ESPHome, Tasmota,
WLED) makes the same call. Digest authentication removes the credential from
the wire; body confidentiality on the home LAN is the accepted residue (see
Tracked items). Terminate TLS at a reverse proxy with a real certificate
before exposing the console beyond the LAN.

## Firmware signing

The device verifies a vendor RSA-3072 signature on every over-the-air image
before it commits, so only firmware signed by the trusted key installs. This
makes the OTA path authenticity-against-forgery, not only
integrity-against-corruption: a swapped release asset, a redirected
custom-install URL, or a man-in-the-middle past TLS is rejected even when its
SHA-256 matches. Release images are signed with the maintainer's key, held only
in a CI secret; developer builds use a key generated on demand into a gitignored
file, so no signing key lives in the repository. Without hardware Secure Boot
the guarantee covers the network path, not boot-time or physical-flash tampering;
Secure Boot v2 is the roadmap step that closes that gap.
[docs/ota.md](ota.md#firmware-signing) owns the mechanism and the key model.

## PCM transport

TLS 1.3 PSK is the decided encrypted transport, kept after measurement. The
memory pressure that once argued for replacing it was OTA installs running
beside a live TLS stream; the install worker now quiesces the transport
before downloading, which removed that concurrency. Measured on hardware
(v0.10.0, TLS-PSK configured, capture running): 113 KB free heap, 45 KB
largest free block, 45.5 KB minimum free since boot including update checks.
A Noise-based replacement would buy back memory that no longer binds at the
cost of a second device and bridge implementation; cleartext-only would be a
downgrade nothing forces.

Encrypted PCM uses the exact TLS 1.3 profile in the
[transport contract](tcp-transport.md). The PSK authenticates one device; the
ephemeral ECDHE exchange provides forward secrecy. TLS record sequence numbers,
fresh handshake values, and the authenticated transcript reject captured
records or sessions. The bridge disables tickets and early data and admits no
source until the exact TLS version, cipher, identity, and key succeed.

The bridge listener accepts exactly one mode. With TLS enabled it rejects
cleartext before source admission; with TLS disabled it accepts cleartext and
does not negotiate TLS. Secure firmware never retries cleartext. Switching
modes requires a coordinated bridge and device cutover with a short expected
interruption.

Device and bridge key mutations require different credentials (the device's
digest-proven admin key; the bridge's bearer token). The
device generates a PCM PSK from the ESP32 random source and reveals it only in
the stage or recovery response. Device state transitions are failure-atomic.
The bridge bounds its key map and publishes it with durable atomic replacement.
Neither side logs or reads back PSKs.

## Release artifact verification

Every published release asset and container image carries signed provenance
recorded by GitHub attestations, and each release ships an SPDX SBOM
(`streamline-<version>.spdx.json` beside the firmware binaries; image SBOMs
are attached as attestations on the image digest). Verify any artifact with
one command:

```sh
# Any release asset: firmware images, ELF, SHA256SUMS, or the SBOM itself
gh attestation verify streamline-<version>-ota.bin --repo lutyjj/esp32-streamline

# Any published container image
gh attestation verify oci://ghcr.io/lutyjj/esp32-streamline-bridge:<version> --repo lutyjj/esp32-streamline
```

Publication verifies every attestation before the release goes public and
fails closed on mismatch. The device's own OTA update keeps its independent
check: it validates the image against the `sha256` the caller supplies from
`SHA256SUMS`.

## Tracked items

| Item | Tracking | Notes |
|---|---|---|
| Cleartext PCM mode | owner-controlled | It provides no confidentiality or source authentication. Use it only when encryption is not enabled or during explicit recovery. |
| HTTP bodies readable in transit on the LAN | by design | Digest keeps the credential off the wire, but request bodies (a Wi-Fi password change, a settings write) stay cleartext, and an active man-in-the-middle can tamper with a body (`auth-int` is not implemented). The routinely sensitive body — the home Wi-Fi password — normally crosses only the WPA2-encrypted setup link at commissioning. See [Control-plane transport](#control-plane-transport). |
| Wi-Fi credentials stored plaintext in NVS | by design | Reachable only with physical flash access; out of scope for a LAN line-in streamer. |
| Button-held boot opens the setup AP for one boot | by design | Physical presence substitutes for the password: an attacker in radio range cannot press the button. The window is one boot and closes on restart. |
| Setup password appears once in the factory-reset response | by design | The response repeats the label credential over the LAN at the one deliberate moment the owner heads back to commissioning — the same shown-once pattern as the PCM PSK reveal. No read endpoint returns it, and rotation means a full flash erase. |
| Bridge WAV stream is unauthenticated | by design | Front it with an authenticating reverse proxy before sharing beyond a trusted LAN. |
| Home Assistant recordings are working data, not backup data | by design | Recordings survive restarts and updates, but restore or uninstall removes them. Download every WAV that must be retained. |

## Bridge

- Keep ports `39000` and `8088` on a trusted network; never expose them
  directly. The Home Assistant add-on exposes the same ports on the Home
  Assistant host.
- Set `--source-allow <ESP32 IPv4>` (or `STREAMLINE_SOURCE_ALLOW`) to reject
  unexpected PCM sources. In the Home Assistant add-on, set `source_allow`.
  This is not a firewall replacement; restrict inbound at the boundary.
- One bridge API token (`STREAMLINE_API_TOKEN`, or the add-on `api_token`
  option, at least 16 random characters) gates every bridge mutation: listener
  mode, device-key enrollment, and recordings. The bridge console keeps it in
  browser session storage and sends it as a bearer token; the API never
  returns it. The token rides plain HTTP, so a LAN token holder can switch the
  listener to cleartext or enroll a key — the device never downgrades itself,
  so a forced bridge downgrade stops audio rather than exposing it. Keep the
  token as private as the LAN and rotate it by changing the deployment value.
- Encrypted source identity comes from the authenticated device key id. The
  key status API returns ids, listener state, and counters but never PSKs.
- An authenticated recording request can mint a one-use download ticket that
  expires after 60 seconds. Keep recordings on trusted storage and terminate
  TLS at a reverse proxy before crossing a trust boundary.
- HTTP bodies, connection workers, socket inactivity, producer workers,
  retained sources, client queues, recording queues, recording duration,
  sequence gaps, download tickets, manifest sizes, directory scans, and list
  results all have finite limits. A client that exceeds a connection or socket
  limit is disconnected without allocating another worker. The 4096-byte body
  ceiling counts every received chunk, so a chunked or length-lying request
  meets the same 413 before authentication or parsing. The request-timeout
  option is a progress deadline at every phase — header read, body read, and
  response write — so a stalled client releases its connection slot instead of
  holding it open.
- The recording page uses a per-response Content Security Policy nonce. It has
  no cross-origin permissions, cookies, third-party scripts, or persistent
  token storage. The bearer header keeps cross-origin form and image requests
  from authorizing an operation.

### Host containment

- The standalone container runs as an unprivileged fixed user. Its supported
  Compose configuration makes the image filesystem read-only, drops every
  Linux capability, sets `no-new-privileges`, and mounts only `/tmp` and the
  recording volume writable.
- The transport state file must be owned by the bridge process user with mode
  `0600`. The bridge validates both properties before parsing enrolled PSKs.
- The Home Assistant add-on uses Supervisor-owned `/data` for options and
  recordings. It maps no additional writable host folder and does not request
  host networking, devices, privileged mode, the Docker socket, Home Assistant
  configuration, or the host-wide shared and media folders. Supervisor backups
  exclude `recordings`; restore and uninstall may therefore remove those files.
- Runtime images pin their Python base image by digest. Dependabot owns digest
  updates so reviewed dependency changes remain mechanical.
- The bridge media path does not invoke a shell, start subprocesses, deserialize
  executable objects, load plugins, or fetch user-selected URLs.

### Recording storage

The recording directory is an untrusted persistence boundary. The store pins
an opened directory descriptor for its lifetime and performs later operations
relative to that descriptor. Replacing the configured path cannot redirect an
active bridge process.

The store refuses a symlink as its root. It creates WAV parts and manifest
temporaries exclusively with mode `0600`, does not follow links, refuses
non-regular and multiply linked artifacts, and atomically publishes completed
files. Downloads stream from the verified open file descriptor rather than
checking one path and reopening it. Recovery applies the same rules before it
repairs a part file.

Manifest JSON is data, not authority. The store bounds its size, requires the
exact versioned fields, validates every type and range, derives byte counts and
duration from frames, checks the expected WAV size, and ignores invalid
records. Directory scans and API lists are bounded.

Someone who can write the recording volume can still delete recordings, fill
its space, or make individual artifacts fail validation. Someone who already
controls the container runtime or host is outside this boundary and can control
the bridge process itself.
