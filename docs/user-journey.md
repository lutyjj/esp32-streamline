# The user journey

StreamLine takes an analog source from a blank board to a network player.
This document owns the experience contract. The [quick start](../README.md#quick-start)
owns installation commands.

## Shared promises

- Input activity, device transmission, bridge reception, and player connections
  are separate facts. Saving a target proves none of them.
- Failed status reads, including reads unanswered after five seconds, replace
  live indicators with an unavailable state.
  Last-known configuration cannot establish current audio delivery.
- Every wait names its operation and completion evidence. A timer never proves
  a network join, successful reboot, or audible playback. A restart still
  offline after a minute reads as overdue on every surface that narrated it.
- An action that can restart the device waits while a firmware update or
  check runs, and says so beside it.
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
| Device | Audio | Check the input and switch saved profiles; open tuning when needed |
| Device | Settings | Connect a player or Wi-Fi, then manage security, hardware, and maintenance |
| Bridge | Listen | Observe sources and copy playback addresses |
| Bridge | Recordings | Capture a source and retrieve saved WAV files |
| Bridge | Settings | Configure audio security, pair sources with Music Assistant, and understand deployment access |

Settings is a task index. Each destination opens one focused task with an
All settings link. URLs identify the task, browser Back retraces navigation,
and visited forms retain drafts. Phones use the same destinations and bottom
primary navigation.

## 1. Install and make first contact

The WebFlasher or documented serial installer writes a board that starts its
setup network. The flasher log and serial monitor show its generated SSID and
password. A pre-provisioned board can carry them on its label. Holding the first
button at power-on opens the setup network for that boot when the password is lost.

Join the setup network and open its captive console, or `http://192.168.71.1/`.
An unconfigured device opens onboarding. Choose Wi-Fi, preserve the generated
admin key, then submit the network change. A network without a password needs
the explicit open-network choice, which names what an open network exposes; a
blank password alone does not save. Back retains entered values.

The setup address and home-network hostname are different browser origins.
Remembering a key at one address does not transfer it to another. Before joining,
the owner confirms the key is saved outside this console. Settings → Wi-Fi keeps the same safeguard.

A transport disconnect during joining is an unconfirmed handoff, not success.
Reconnect to home Wi-Fi, open the advertised device address, and enter the saved
key there. Reaching that console verifies the join. Closing onboarding exposes
Settings → Wi-Fi without hiding the custody requirement.

## 2. Connect a bridge and player

Capture and calibration work before a bridge exists. Audio offers Connect bridge
when no destination is configured. The guide explains Home Assistant, Docker,
or an existing installation, then saves the target. Settings → Connect a player also provides
the host and port form; both use the same API.

When the guide asks for the bridge, the device searches its network for about
three seconds and the guide lists the bridges that answer, up to eight, by
name and address. Settings → Connect a player runs the same search on request. Use fills the host and
port and never saves them. A listed bridge is a hint, since any host on the
network can advertise one, so the owner compares the address before saving.
No answer, or a failed search, names the manual fallback: a bridge behind port
mapping or a network that blocks multicast stays reachable by its typed
address. The device searches only from the home network, so the setup network
offers the form alone.

After saving, the device distinguishes restarting, quiet input, connecting, and
sending. Only observed transmission supports Sending audio. Open the bridge
to verify reception, then copy the playback URL from Listen into an HTTP WAV
player. The guide accepts the owner’s bridge console address and links directly
to Listen; it never infers an HTTP port from the audio target. An ingress-hosted
bridge needs its player-accessible public URL configured separately. The console does not play audio. A connected player does not prove its
speakers are audible.

A bridge configured with a Sendspin server offers every source to Music
Assistant. Bridge Settings → Music Assistant shows each source's next step:
connecting, needs pairing, input off, ready, or playing. Pairing reveals a
token once in the bridge console and pastes it into the source's setup in
Music Assistant; the token is a secret, so locking the bridge console clears
it. A ready source appears under Live Inputs. Music Assistant, not the bridge,
decides when it plays, including automatic playback when the input gets a
signal.

## 3. Set input levels

Audio places saved profiles beside the live meter. Adjust input opens a focused
editor with its own live meter, Save, and Discard changes. Fields remain locked
while saving. Changes apply when saved, except on an unconfigured device, where
they wait without a restart and apply once it starts on the home network;
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

Settings → Device assigns advertised buttons and LEDs. Destructive button
assignments carry a warning. A console pause is not a persistent shutdown;
restarting resumes streaming according to firmware policy.

Bridge Listen shows known sources, levels, connection state, playback addresses,
and reception details. Recordings separates capture from the file library.
Record this audio carries the selected source through unlocking; a missing
source never silently becomes a different input. Storage headroom stays visible
during capture. A source appears when its device connects with streaming enabled,
including during quiet input. Start recording
before the desired passage, observe its state, then stop and save. The active
session replaces the new-recording form; another recording is an explicit action.
Finalized files offer download and confirmed deletion. [Recordings](recordings.md)
owns storage, gaps, limits, and interrupted files.

A bridge without an API token names the deployment option to configure. It never
directs the owner to an unavailable unlock action.

## 5. Enable encrypted audio

Settings → Encrypted audio offers Set up encryption or Resume setup. Generate
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

Settings → Troubleshooting exposes health, the protected device log, and raw status.
Settings → Developer API exposes the machine interface. Settings → Restart & reset
contains restart and confirmed factory reset.

A provisioned device that cannot reach its saved Wi-Fi serves a recovery console
on its setup network, not first-run commissioning. A banner names the network and
what the latest join attempt found: no such network in range, a rejected
password, or security the saved settings cannot use, such as a network that
added or removed its password. The device retries every minute and rejoins on its own; Change Wi-Fi
opens Settings → Wi-Fi for a renamed network or a new password. Unlock requires
the admin key. A blank password field keeps the stored password; a saved open
network has none to keep, so switching it to a protected one needs the password. Changing
Wi-Fi leaves audio, target, profiles, identity, board, and update schedule intact
and ends in the same network handoff as first contact. When contact ends, the
console says the device has probably rejoined if its setup network is gone and
names the home-network address that confirms it. A restart or rebooting save from
recovery ends the same way when the device stays away from its setup network for
a minute. The setup password survives resets;
physical boot recovery remains available when that password is lost.

A codec fault leaves network management reachable. Factory reset returns to
commissioning. Lost admin access requires the documented physical recovery or
reflash path; a read endpoint cannot recover a secret.

Any change to a stage updates this contract and tests its cross-screen consequences.
