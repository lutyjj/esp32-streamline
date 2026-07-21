# Over-the-Air Updates

The device updates itself from GitHub releases. Daily automatic updates are
enabled by default. After a ten-minute boot delay, the device checks on its
selected daily or weekly cadence, waits for audio to be idle, installs a newer
release into the inactive app slot, and reboots into it. System → Firmware can
change the cadence, disable automatic updates, or start the same flow by hand.

## Partition layout

`firmware/streamline/partitions.csv` defines a two-slot OTA table sized for 4 MB
flash, the common ESP32 module size; an 8 MB board runs it too, leaving its upper
half unused. It is applied at flash time via `espflash --partition-table`, so the
`CONFIG_PARTITION_TABLE_CUSTOM*` keys stay out of `sdkconfig.defaults`:

| Partition | Size | Role |
|---|---|---|
| `nvs` | 24 KB | Wi-Fi/target/audio config, audio profiles, selected board descriptor, and admin key |
| `otadata` | 8 KB | Records the bootable slot |
| `phy_init` | 4 KB | RF calibration |
| `ota_0`, `ota_1` | 1.9 MB each | Application slots; the bootloader runs one and updates the other |

## Update flow

The console separates checking from installing: `POST /api/ota/check` reports
whether a newer release exists (`up-to-date` or `update-available`) without
touching flash, and `POST /api/ota/update` performs the install. Both run on a
background worker and require the admin-key bearer token.

1. The console `POST`s `/api/ota/check` or `/api/ota/update`.
2. A worker task fetches `releases/latest/download/SHA256SUMS` over HTTPS and
   reads the `-ota.bin` entry — one small file yields both the latest version
   and the expected digest, so no GitHub API call or token is needed.
3. For a check, it reports the result and stops. For an update, if the release
   is newer than the running firmware, it streams
   `releases/latest/download/streamline-<ver>-ota.bin` straight into the
   inactive slot, hashing as it writes.
4. On a SHA-256 match it commits the boot pointer and reboots; a mismatch aborts
   the write and leaves the running slot untouched.
5. Progress and result surface in `/api/status` under `ota`, which the console
   polls.

`GET /api/settings` reports the persisted `auto_update_schedule` policy.
`POST /api/settings/firmware` changes it to `disabled`, `daily`, or `weekly`;
the setting applies without a reboot. Existing provisioned devices adopt the
daily default when they first run firmware that supports the setting.

## Custom image installs (development)

`POST /api/ota/update` with form fields `url` and `sha256` installs that exact
image instead of the latest release — no USB access needed to test a build:

1. `make firmware-artifacts` (produces `dist/firmware/streamline-dev-ota.bin`
   and `SHA256SUMS`).
2. Serve it on the LAN: `cd dist/firmware && python3 -m http.server 8000`.
3. In the console's **System → Firmware → Developer — install a custom image**
   form, enter
   `http://<your-host>:8000/streamline-dev-ota.bin` and the digest from
   `SHA256SUMS`, then **Install custom image**.

The admin-supplied SHA-256 — not the transport — is the root of trust: the
device rejects any payload whose digest differs, so a plain-HTTP LAN URL is
acceptable (and skips the clock sync that only TLS needs, so an offline bench
works). Custom installs skip the version comparison — a `dev` build can replace
any release — and keep the rollback net below. Signed query parameters remain
part of the download request, but status, diagnostics, and logs identify the
source only as a custom image. URLs with userinfo or fragments are rejected.

## Safety: rollback

`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` boots a freshly flashed slot in
*pending-verify*. The firmware calls `esp_ota_mark_app_valid_cancel_rollback`
once it reaches the home network with the console up — the signal that the image
boots and is manageable. Audio is deliberately outside this gate: a codec that
will not initialize is a fault to fix (see [Startup health](#startup-health)),
not a reason to revert, so it can never trigger a rollback. An image that
crashes or cannot reach the network never confirms itself, and the bootloader
reverts to the previous slot on the next reset. A bad update cannot brick the
device.

### Manual rollback

`POST /api/ota/rollback` returns to the previous firmware deliberately, without
waiting for a bad boot. It points the next boot at the inactive slot and
restarts — instant and offline, no re-download, going back one version. That
slot boots in *pending-verify* like any other, so the same confirm-or-revert net
applies. `/api/status` advertises `ota.rollback_available` and
`ota.rollback_version`, read from the inactive slot, so the console offers the
action only when a valid previous image is stored and can name the version it
returns to. A freshly serial-flashed device, with only one slot written, reports
it unavailable.

## Startup health

Reaching the network confirms the image *boots*; it does not prove the device is
*usable*. A separate startup health check answers that. Once the network is up,
the firmware assembles a boot snapshot — did the audio codec answer, is a bridge
configured — into a verdict: an overall severity plus a check list, each with a
`status`, a `severity` (`ok`, `info`, or `blocking`), a plain-language `detail`
and `remedy`, and a `fixable` flag.

The verdict rides `/api/status` under `health`, and `GET /api/health` returns
its status code — `200` when nothing blocks, `503` when a check does — for
scriptable probes. A blocking fault, such as a codec that will not initialize,
keeps the device provisioned and reachable so the fault is visible and fixable
rather than dropping it to the setup AP; the console surfaces it on the Overview.
The check is a one-time boot snapshot — intermittent or periodic checks are out
of scope, and a new check is a new entry in the firmware's `health` module.

## Post-mortem diagnostics

`/api/status` reports a `diagnostics` block that survives reboots:

- `last_ota` — how the last install attempt ended, tagged with the version that
  ran it. After a rollback the running version contradicts this note, which is
  the tell.
- `last_fallback` — why the device last fell back to the setup AP.
- `reset_reason` — what produced this boot: `power-on`, `software` (OTA or
  config reboot), `panic`, or a watchdog.

The console shows diagnostics in the Overview tab and the raw JSON in the
System tab.

## Security

| Control | Effect |
|---|---|
| Admin-key bearer token on `/api/ota/update` | Only the owner can trigger an update |
| TLS via the mbedTLS certificate bundle | Authenticates `github.com`; the image cannot be swapped in transit |
| Published SHA-256 verified before commit | Detects truncated or corrupted downloads |
| Bootloader image checksum + rollback | A malformed or non-booting image reverts automatically |

This matches the appliance's threat model (a single owner on a trusted LAN,
pulling signed GitHub releases). Image *authenticity* rests on HTTPS to GitHub
rather than a burned signing key; signed-image verification
(`CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`) is the next step if a hardware
root of trust is ever required.

## Build artifacts

`make artifacts` produces both images, listed by basename in `SHA256SUMS`:

- `streamline-<ver>-full.bin` — serial-flash image bundling the OTA partition
  table and the rollback-enabled bootloader. Flash it once over USB to move a
  device onto the OTA layout.
- `streamline-<ver>-ota.bin` — bare application image the device pulls for
  over-the-air updates.

## Migrating existing devices

OTA writes only app slots — never the partition table or bootloader — so a change
to the flash layout is a one-time serial reflash of a `-full.bin` (web flasher or
`espflash`/`esptool`). Erase the flash first, so stale `otadata` or an old table
cannot point the bootloader at a slot that moved; the web flasher does this and
lands the device fresh in setup mode. Every update after that is over-the-air.

Two layouts have needed this reflash: the original single-app image, and the 8 MB
two-slot table that the 4 MB layout replaced. A device already on the 4 MB layout
never needs it again.
