# Over-the-air updates

The device installs signed firmware from GitHub releases. Daily automatic
updates are enabled by default. After a ten-minute boot delay, the device checks
on its selected daily or weekly cadence and waits for idle audio before updating.
System → Firmware controls the schedule and offers manual checks and installs.

## Update flow

`POST /api/ota/check` checks for a newer release without writing flash or pausing
audio. `POST /api/ota/update` installs it. Both require digest authentication and
return `202` after reserving their background worker. An active worker returns
`409`; a worker that cannot start returns `503` and leaves OTA available to retry.
An automatic attempt that cannot start retries after one minute, still waiting
for idle audio and respecting the disabled schedule.

1. HTTPS requires a usable wall clock. A clock at or after January 1, 2025 skips
   the SNTP wait; certificate validity dates remain enforced by mbedTLS. An unset
   clock waits up to 45 seconds for synchronization. Plain HTTP skips this step.
2. The worker fetches `releases/latest/download/SHA256SUMS`. The `-ota.bin` entry
   supplies the release version and expected digest. A failed fetch retries once
   after one second, with the failed connection released. Checks keep audio running.
   The TCP receive window is four segments (5,760 bytes), limiting queued input
   beside TLS allocations. The PCM send buffer has its own 23,040-byte budget.
3. A check reports `up-to-date` or `update-available` and stops. An install
   proceeds only if the release is newer than the running firmware.
4. Before downloading the image, the installer pauses streaming and waits for
   the sender to close its PCM connection, freeing socket and TLS buffers. Audio
   meters stay live. If the sender cannot release, the install fails with both
   slots intact. A device without a sender proceeds immediately.
5. The image streams into the inactive slot while SHA-256 is calculated. The TLS
   receive buffer is allocated once after the handshake and held until download
   finishes, avoiding repeated large allocations on a fragmenting heap.
6. The image must match its expected SHA-256 and the running firmware's signing
   key. Only then does the installer select the new boot slot and restart.
   A failure resumes streaming and reports its cause.

`GET /api/status` reports progress under `ota`. `GET /api/settings` reports
`auto_update_schedule`; `POST /api/settings/firmware` sets `disabled`, `daily`,
or `weekly` without a reboot.

## Custom image installs (development)

`POST /api/ota/update` with form fields `url` and `sha256` installs that exact
image regardless of version. A custom install uses the same signature and
checksum verification as a release install.

1. Run `make firmware-artifacts`. It creates
   `dist/firmware/streamline-dev-ota.bin` and `SHA256SUMS`.
2. Serve the artifacts on the LAN using an HTTP server.
3. Submit the image URL and its digest through the API or System → Firmware →
   Developer → Install a custom image.

A plain HTTP URL works on an offline bench because the signature authenticates
the image and the admin-supplied digest pins its bytes. Signed query parameters
remain in the request; status, logs, and diagnostics identify the source only as
"custom image". URLs with userinfo or fragments are rejected.

### Signing keys and development builds

To test a revision on a release-key device, dispatch the **CI** workflow on its
branch with **Sign this revision for testing on release-key devices** enabled:

```sh
gh workflow run ci.yml --ref <branch> -f sign_firmware=true
```

The manual run builds and checks the firmware, signs the hardware image with the
repository's signing key, and uploads `signed-firmware-<commit>` as a three-day
workflow artifact. Download it with `gh run download <run-id> -n
signed-firmware-<commit>`, then install its OTA image through the custom-image
API. This does not publish a release or change automatic-update assets. Only
maintainers who can dispatch workflows can request this signing operation;
ordinary pull-request runs never use the signing key. Review the selected
revision before dispatching: its image will be trusted by release-key devices.

For unattended transport tests, also set `test_source=true`. This build replaces
captured PCM with a 1 kHz square wave while preserving real I2S read timing,
Wi-Fi, and the selected transport. It reports `firmware_variant: test-source` in
status and the console. The normal image reports `standard` and excludes the
generator. Install the normal image after testing. Local builds select the same
variant with `make firmware-artifacts FEATURES=test-source`.

A device accepts only the key in **signature block 0 of its running image**.
ESP-IDF signed-on-update mode compares only block 0 of the incoming image against
that key. Adding a second signature block does not switch the trusted key.

A development-signed device cannot install a release-signed image. A
release-signed device cannot install a development-signed image. Switching keys
requires a serial flash of the destination key's `-full.bin`. Repeated OTA
attempts cannot change this: they download the image and consume the inactive
slot before signature verification rejects it.

`GET /api/status` reports `ota.signing_key_sha256`, the SHA-256 of the running
image's block-0 public key, or an empty string if it cannot be read. System →
Firmware → Developer shows the same digest. `signed_updates` describes signature
enforcement; it does not identify a release key. Compare the digest with the
signing key used to produce the intended image. A version match alone says
nothing about signing-key compatibility.

## Safety: rollback

The rollback-enabled bootloader starts a newly installed slot in
*pending-verify*. Firmware confirms it only after the device reaches its home
network, registers every management route, and successfully reads complete
responses from `/api/status` and `/api/settings` through the HTTP server.

HTTP startup, route registration, or probe failure leaves the image unconfirmed.
The firmware records a management startup failure in the persistent OTA note
when storage is available and restarts on a fatal error. A reset before
confirmation lets the bootloader revert to the previous image. Recovery mode
confirms only after the saved network returns and the management probes pass,
before restarting into provisioned mode.

The QEMU smoke installs a signed `qemu-fail-management` image whose management
probe receives HTTP 404. It verifies the automatic restart, return to the
confirmed slot, and persisted failure note. This variant implies `qemu` and is
excluded from hardware builds.

Audio health is outside the confirmation gate. A failed codec stays visible in
the console and cannot cause a firmware rollback.

### Manual rollback

`POST /api/ota/rollback` selects the inactive slot and restarts without a download.
That image boots pending verification and must pass the same management gate.
`ota.rollback_available` and `ota.rollback_version` describe the valid image in
the inactive slot. A device with only one written slot reports it unavailable.

An install consumes the rollback image when it starts writing the inactive slot.
A later download or verification failure leaves the running image intact but may
leave no rollback image. Status reads the slot state afresh to report this.

## Startup health

Startup health describes whether the audio codec initialized and a bridge is
configured. `/api/status` carries the verdict under `health`, including severity,
details, remedies, and whether each condition can be fixed through configuration.
`GET /api/health` returns `200` when nothing blocks and `503` for a blocking fault.

This boot snapshot describes audio usability separately from management
readiness. A codec failure keeps the provisioned device reachable for repair.
See [the user journey](user-journey.md).

## Post-mortem diagnostics

`/api/status` reports persistent `diagnostics.last_ota` and
`diagnostics.last_fallback`, plus this boot's `reset_reason`. The OTA note names
the firmware version that wrote it, so a rollback can be identified when the
running version differs. The console exposes these diagnostics; the
[diagnostics reference](diagnostics.md) covers logs and crash dumps.

## Firmware signing

Firmware enforces RSA-3072 signatures through ESP-IDF signed-app verification
without hardware Secure Boot (`CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`).
It requires ESP32 revision 3.0 or later. No eFuse is burned. Physical serial
flashing can replace the trusted image, so this protects the OTA path rather than
boot-time or physical-flash integrity.

The build produces a secure-padded application; `espsecure.py sign_data --version 2`
appends the signature. Release CI signs with `FIRMWARE_SIGNING_KEY`, held in its
release secret and removed after signing. The private key never enters the build.

Development and QEMU builds use the gitignored
`firmware/streamline/.dev_signing_key.pem`, generated on first use. Keep this key
for subsequent installs on devices enrolled with it. To supply a different key,
run `make firmware-artifacts SIGNING_KEY=my_key.pem`. A missing explicit key
fails the build; it does not generate a substitute. Serial-flash the resulting
full image to enroll that key. See [signing-key constraints](#signing-keys-and-development-builds).

## Security

| Control | Effect |
|---|---|
| RSA-3072 signature | Rejects images not signed by the running image's trusted key |
| Digest authentication | Requires the admin key for checks, installs, and rollback |
| SHA-256 | Pins image bytes before signature verification and boot selection |
| HTTPS certificate validation | Authenticates release download servers |
| Bootloader rollback | Reverts an image that resets before management confirmation |

Image authenticity rests on the signing key. A matching checksum or HTTPS
connection alone cannot authorize an image signed by a different key. See the
[security reference](security.md) for the trusted-LAN boundary.

## Partition layout

`firmware/streamline/partitions.csv` owns the layout for 4 MB or larger flash.
Larger devices leave their upper flash unused. The table is applied at serial
flash time, not by OTA.

| Partition | Size | Role |
|---|---|---|
| `nvs` | 24 KB | Device configuration and credentials |
| `otadata` | 8 KB | Boot-slot selection and verification state |
| `phy_init` | 4 KB | RF calibration |
| `coredump` | 56 KB | Persistent crash dump |
| `ota_0`, `ota_1` | 1.9 MB each | Running and inactive application slots |

## Build artifacts

`make firmware-artifacts` creates signed images and lists their digests in
`SHA256SUMS`:

- `streamline-<ver>-full.bin`: partition table, rollback-enabled bootloader, and
  signed application for serial flashing.
- `streamline-<ver>-ota.bin`: signed application for OTA.

## Migrating existing devices

OTA cannot change the partition table or bootloader. A layout change requires
erasing flash and serial-flashing the full image, then commissioning the device.
