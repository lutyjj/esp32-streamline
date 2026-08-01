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
| `coredump` | 56 KB | Crash dump a panic writes, served by the [diagnostics API](diagnostics.md#crash-dumps) |
| `ota_0`, `ota_1` | 1.9 MB each | Application slots; the bootloader runs one and updates the other |

## Update flow

The console separates checking from installing: `POST /api/ota/check` reports
whether a newer release exists (`up-to-date` or `update-available`) without
touching flash, and `POST /api/ota/update` performs the install. Both run on a
background worker and require the admin key (digest authentication).

1. The console `POST`s `/api/ota/check` or `/api/ota/update`.
2. A worker task fetches `releases/latest/download/SHA256SUMS` over HTTPS and
   reads the `-ota.bin` entry — one small file yields both the latest version
   and the expected digest, so no GitHub API call or token is needed.
3. For a check, it reports the result and stops. For an update, if the release
   is newer than the running firmware, the worker pauses audio streaming and
   waits for the sender to confirm it: the PCM connection closes, freeing its
   socket and TLS buffers so the download, hashing, and flash writes fit in
   memory. The download starts only after that confirmation, so no reconnect
   can race it for the buffers it just freed. A device with no bridge target
   holds no connection and starts at once. The status message narrates the
   pause; audio meters stay live. A sender that will not release fails the
   install cleanly with both firmware slots intact.
4. It streams `releases/latest/download/streamline-<ver>-ota.bin` straight into
   the inactive slot, hashing as it writes. The connection allocates its TLS
   receive buffer once, after the handshake, and holds it until the download
   ends, so the transfer never waits on a large allocation from a heap that
   fragments as it runs.
5. On a SHA-256 match it commits the boot pointer and reboots; a mismatch aborts
   the write and leaves the running slot untouched. Any other failure aborts the
   same way and resumes streaming.
6. Progress and result surface in `/api/status` under `ota`, which the console
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

A custom image passes the same two checks as a release: its bytes must match the
admin-supplied SHA-256, and it must carry a valid vendor signature (see
[firmware signing](#firmware-signing)). Build and sign a developer image with
`make firmware-artifacts`, which signs with this machine's generated development
key; a device enrolled with that key accepts it, and any device rejects an image
its trusted key did not sign. Because both checks are on the content, a
plain-HTTP LAN URL is acceptable and skips the clock sync that only TLS needs,
so an offline bench works. Custom installs skip the version comparison — a `dev` build can replace
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

Installing consumes the rollback image: the previous firmware lives in the
inactive slot, and the install erases that slot before writing into it. A
download that fails after that point leaves the device on its running image
with no rollback until the next successful install, and `/api/status` reads the
slot state fresh so `rollback_available` reports that honestly.

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
| Vendor RSA-3072 signature verified before commit | `esp_ota` rejects any image the trusted key did not sign, so only vendor firmware installs |
| Admin-key digest authentication on `/api/ota/update` | Only the owner can trigger an update |
| Published SHA-256 verified before commit | Detects a truncated or corrupted download before the signature check |
| TLS via the mbedTLS certificate bundle | Authenticates `github.com` for the release download |
| Bootloader image checksum + rollback | A malformed or non-booting image reverts automatically |

Image authenticity rests on the signing key, not on HTTPS to GitHub. The
firmware carries the vendor's RSA-3072 public key and verifies the appended
signature before it commits a slot, so a forged image that matches the caller's
SHA-256 — a compromised release asset, a swapped custom-install URL, or a
man-in-the-middle past TLS — is still rejected. See
[firmware signing](#firmware-signing).

The signature guards the over-the-air path. It is not boot-time or
physical-flash verification: without hardware Secure Boot the bootloader does
not check the signature, so someone with physical flash access can still write
an unsigned image. Secure Boot v2 with a burned key closes that gap and is the
next step on the security roadmap.

## Firmware signing

The firmware verifies a vendor RSA-3072 signature on every over-the-air image
using ESP-IDF signed-app verification without hardware Secure Boot
(`CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`, RSA scheme). No eFuse is
burned, so signing stays reversible: a serial reflash of an unsigned build
removes the enforcement.

How the trust chain works without a hardware anchor:

- The running application embeds the public key in an appended signature block.
  When it installs an update, `esp_ota` verifies the new image's signature
  against that embedded key and refuses to commit a slot on a mismatch. A device
  therefore accepts only images signed by the key its current firmware already
  trusts.
- The image is built secure-padded but unsigned; CI appends the signature block
  after the build (`espsecure.py sign_data --version 2`), so the private key
  never reaches the build machine.
- The RSA scheme requires an ESP32 of chip revision 3.0 (ECO3). Revisions 0 to 2
  lack the v2 signature support and cannot run this firmware.

No signing key lives in the repository. Two key domains come from one source
tree, and a device accepts only the domain whose key it was enrolled with:

- **Release units** run images signed by the maintainer's key, held only in the
  `FIRMWARE_SIGNING_KEY` release secret and shredded after each signing run.
- **Developer and QEMU builds** are signed with a key `make firmware-artifacts`
  generates on first use into the gitignored
  `firmware/streamline/.dev_signing_key.pem`, the way the kernel generates its
  module-signing key. A fresh checkout therefore builds a bootable, installable
  image with no setup, and each machine signs with its own key. That key is a
  development credential, not a vendor identity: keep it off product units.

To sign with a key you manage instead, generate one with
`espsecure.py generate_signing_key --version 2 --scheme rsa3072 my_key.pem`,
then run `make firmware-artifacts SIGNING_KEY=my_key.pem`. Serial-flash the
resulting `-full.bin` once to enroll that key; the device then accepts only
over-the-air images you sign with it. A `SIGNING_KEY` that names a missing file
fails the build rather than generating a substitute, so a release can never ship
signed by a throwaway.

Because the over-the-air path enforces signatures, a device cannot be moved to a
different key over the air. Adopting signing on an existing unsigned device is a
normal update: the unsigned firmware installs the first signed image, and every
update after that is verified. Moving between key domains, or back to an
unsigned build, needs a one-time serial reflash.

## Build artifacts

`make artifacts` produces both images, listed by basename in `SHA256SUMS`. Both
carry the appended vendor signature (see [firmware signing](#firmware-signing)),
so the application in each is the signed one:

- `streamline-<ver>-full.bin` — serial-flash image bundling the OTA partition
  table, the rollback-enabled bootloader, and the signed application. Flash it
  once over USB to move a device onto the OTA layout and enroll its signing key.
- `streamline-<ver>-ota.bin` — signed application image the device pulls for
  over-the-air updates.

## Migrating existing devices

OTA writes only app slots — never the partition table or bootloader — so a change
to the flash layout is a one-time serial reflash of a `-full.bin` (web flasher or
`espflash`/`esptool`). Erase the flash first, so stale `otadata` or an old table
cannot point the bootloader at a slot that moved; the web flasher does this and
lands the device fresh in setup mode. Every update after that is over-the-air.

Two layouts have needed this reflash: the original single-app image, and the 8 MB
two-slot table that the 4 MB layout replaced. A device on a 4 MB layout without
the `coredump` partition keeps every capability except crash capture, which its
firmware reports unavailable; the reflash that adds the partition is optional
and adds nothing else.
