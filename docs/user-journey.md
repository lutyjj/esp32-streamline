# The user journey

StreamLine takes an analog source from a blank board to a network player.
This document owns the experience contract. The [quick start](../README.md#quick-start)
owns installation commands; [DESIGN.md](../DESIGN.md) owns visual conventions.

## Shared promises

- Input activity, device transmission, bridge reception, and player connections
  are separate facts. Saving a target proves none of them.
- Failed status reads replace live indicators with an unavailable state.
  Last-known configuration cannot establish current audio delivery.
- Every wait names its operation and completion evidence. A timer never proves
  a network join, successful reboot, or audible playback.
- Failures explain the next action. Guided tasks offer cancellation or recovery.
- Generated admin and audio keys have deliberate one-time reveals and copy actions.
- Locked settings remain readable and offer contextual unlocking. Both consoles
  use one credential-dialog pattern. Device admin keys and bridge API tokens are
  separate. [Security](security.md) defines protected reads and writes.
- Visiting another workspace or settings category preserves edited fields for
  the page session. Reloading is not draft persistence.
- Switches represent applied boolean settings. Encryption uses explicit task
  actions because it coordinates two systems and may interrupt audio.

## Workspaces

| Console | Workspace | Task |
|---|---|---|
| Device | Audio | Observe input, adjust levels, calibrate, and apply profiles |
| Device | Connections | Set the audio destination, Wi-Fi, and encryption |
| Device | Settings | Configure identity, hardware, access, updates, and diagnostics |
| Bridge | Listen | Observe sources and copy playback addresses |
| Bridge | Recordings | Capture a source and retrieve saved WAV files |
| Bridge | Settings | Configure audio security and understand deployment access |

Device settings separate General, Access, Updates, Maintenance, Diagnostics,
and Developer API. Phones use bottom primary navigation and a settings-category
selector. Both preserve visited forms.

## 1. Install and make first contact

The WebFlasher or documented serial installer writes a board that starts its
setup network. The flasher log and serial monitor show its generated SSID and
password. A pre-provisioned board can carry them on its label. Holding the first
button at power-on opens the setup network for that boot when the password is lost.

Join the setup network and open its captive console, or `http://192.168.71.1/`.
An unconfigured device opens onboarding. Choose Wi-Fi, preserve the generated
admin key, then submit the network change. Back retains entered values.

The setup address and home-network hostname are different browser origins.
Remembering a key at one address does not transfer it to another. Before joining,
the owner confirms the key is saved outside this console. The normal Connections
setup path keeps the same safeguard.

A transport disconnect during joining is an unconfirmed handoff, not success.
Reconnect to home Wi-Fi, open the advertised device address, and enter the saved
key there. Reaching that console verifies the join. Closing onboarding exposes
the Connections forms without hiding the custody requirement.

## 2. Connect a bridge and player

Capture and calibration work before a bridge exists. Audio offers Connect bridge
when no destination is configured. The guide explains Home Assistant, Docker,
or an existing installation, then saves the target. Connections also provides
the host and port form; both use the same API.

After saving, the device distinguishes restarting, quiet input, connecting, and
sending. Only observed transmission supports Sending audio. Open the bridge
to verify reception, then copy the playback URL from Listen into an HTTP WAV
player. The console does not play audio. A connected player does not prove its
speakers are audible.

## 3. Set input levels

Audio places the meter beside input settings. Changes apply when saved;
the meter describes applied settings while a draft is edited. A clipping warning
offers calibration. The guide asks the owner to pause the source and play loud
material. Cancellation restores entry levels and reports restoration failures;
completion applies the measured result.

Profiles capture applied settings, not unsaved fields. Saving or replacing a
profile requires saving or deliberately discarding the displayed draft first.
Selection is separate from profile management. Importing profiles does not apply
them, and incompatible profiles fail with a reason.

Boards that support analog passthrough expose an immediate switch. It names the
physical output and fixed line-level route. Input gain, attenuation, calibration,
and streaming controls do not control output volume.

## 4. Operate and record

Audio distinguishes codec faults, deliberate pauses, quiet input, connection
attempts, and transmission. Resume reverses a pause. External button or API
changes update fields the user has not edited. The console never guesses which
physical source a waveform represents.

Settings → General assigns advertised buttons and LEDs. Destructive button
assignments carry a warning. A console pause is not a persistent shutdown;
restarting resumes streaming according to firmware policy.

Bridge Listen shows known sources, levels, connection state, playback addresses,
and reception details. Recordings separates capture from the file library.
An unseen source must play once for discovery before selection. Start recording
before the desired passage, observe its state, then stop and save. The active
session replaces the new-recording form; another recording is an explicit action.
Finalized files offer download and confirmed deletion. [Recordings](recordings.md)
owns storage, gaps, limits, and interrupted files.

A bridge without an API token names the deployment option to configure. It never
directs the owner to an unavailable unlock action.

## 5. Enable encrypted audio

Connections → Encrypted audio offers Set up encryption or Resume setup. Generate
and preserve a credential, enroll it under bridge Settings → Audio security,
require encryption there, verify from the device, then activate and restart.

The bridge mode affects every connected device. Switching the bridge before device
activation pauses cleartext audio. Failed verification does not activate the
device credential. Closing the guide retains staged progress; discarding a staged
credential does not restore the bridge mode. Recovery explicitly requires restoring
cleartext on the bridge when abandoning that transition.

Active encryption needs no routine intervention. Advanced security contains key
replacement, rollback, and lost-key recovery. The generated secret is unavailable
after dismissal. [TCP transport](tcp-transport.md) owns the protocol and API sequence.

## 6. Maintain and recover

Settings → Updates owns scheduling, checks, installation, rollback, and developer
installs. Updates narrate interruption and recovery. A failed install does not
claim completion. [OTA](ota.md) owns verification and rollback behavior.

Settings → Diagnostics exposes health, the protected device log, and raw status.
Settings → Developer API exposes the machine interface. Settings → Maintenance
contains restart and confirmed factory reset.

A provisioned device that loses Wi-Fi exposes a recovery form on its setup network,
not first-run commissioning. Unlock requires the admin key. Blank write-only
password fields retain stored values. Changing Wi-Fi leaves audio, target,
profiles, identity, board, and update schedule intact. The device keeps retrying
its saved network. Its setup password survives resets; physical boot recovery
remains available when that password is lost.

A codec fault leaves network management reachable. Factory reset returns to
commissioning. Lost admin access requires the documented physical recovery or
reflash path; a read endpoint cannot recover a secret.

Any change to a stage updates this contract and tests its cross-screen consequences.
