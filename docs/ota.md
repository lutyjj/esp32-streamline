# Over-the-Air Updates

The device updates itself from GitHub releases: the web console's **Check &
update firmware** button pulls the latest release, flashes it to the inactive
app slot, and reboots into it.

## Partition layout

`firmware/streamline/partitions.csv` defines a two-slot OTA table on 8 MB flash
(`esp-idf-sys` auto-detects it; the `CONFIG_PARTITION_TABLE_CUSTOM*` keys stay
out of `sdkconfig.defaults`):

| Partition | Size | Role |
|---|---|---|
| `nvs` | 24 KB | Wi-Fi/target/audio config and admin key |
| `otadata` | 8 KB | Records the bootable slot |
| `phy_init` | 4 KB | RF calibration |
| `ota_0`, `ota_1` | 3 MB each | Application slots; the bootloader runs one and updates the other |

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

## Safety: rollback

`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` boots a freshly flashed slot in
*pending-verify*. The firmware calls `esp_ota_mark_app_valid_cancel_rollback`
only after it reaches a healthy streaming state; an image that crashes or fails
to connect never confirms itself and the bootloader reverts to the previous slot
on the next reset. A bad update cannot brick the device.

## Post-mortem diagnostics

`/api/status` reports a `diagnostics` block that survives reboots:

- `last_ota` — how the last install attempt ended, tagged with the version that
  ran it. After a rollback the running version contradicts this note, which is
  the tell.
- `last_fallback` — why the device last fell back to the setup AP.
- `reset_reason` — what produced this boot: `power-on`, `software` (OTA or
  config reboot), `panic`, or a watchdog.

The console shows all three on the Status tab.

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

OTA cannot repartition flash, so a device on the older single-app layout must be
re-flashed once over serial with a `-full.bin` (web flasher or `espflash`). Every
update after that is over-the-air.
