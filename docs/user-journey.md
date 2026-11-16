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
- Any other request the device leaves unanswered for ten seconds fails, and
  the screen that sent it says so. Nothing waits on a silent device. The
  bridge console gives up on a status read after five seconds and on any
  other request after thirty, past the bridge's own longest wait.
- Every wait names its operation and completion evidence. A timer never proves
  a network join, successful reboot, or audible playback. A restart still
  offline after a minute reads as overdue on every surface that narrated it.
- An action that can restart the device waits while a firmware update or
  check runs, and says so beside it.
- Failures explain the next action. Guided tasks offer cancellation or recovery.
- Generated admin and audio keys have deliberate one-time reveals and copy actions.
- Locked settings remain readable. A change that needs the device's admin key
  asks for it when it is made and then completes; both consoles use one
  credential-dialog pattern. Device admin keys and bridge API tokens are
  separate. [Security](security.md) defines protected reads and writes.
- Leaving a screen that holds unsaved changes, by a link, Back or a reload,
  asks first and names what is lost. Only saving keeps a change.
- Switches represent applied boolean settings. Encryption uses explicit task
  actions because it coordinates two systems and may interrupt audio.

## Workspaces

| Console | Workspace | Task |
|---|---|---|
| Device | Audio | Check the input, what the audio is doing, and saved profiles; open tuning when needed |
| Device | Bridge | Connect a bridge and follow delivery to it; set up encrypted audio |
| Device | Device | Wi-Fi, the name and hardware, the admin key, and what this browser keeps |
| Device | Maintenance | Updates, diagnostics, the machine interface, restart and reset |
| Bridge | Sources | Follow each source's reception, copy its playback address, pair it with Music Assistant, and record it |
| Bridge | Recordings | Capture a source and retrieve saved WAV files |
| Bridge | Settings | Configure audio security and see what the deployment sets |

The device console's Device and Maintenance workspaces and the bridge
console's Settings hold sections, and a guided task opens on a screen of its
own beneath its workspace, as one source does beneath Sources. URLs identify
the workspace, section, task, or source, and browser Back retraces
navigation. Phones use the same destinations and bottom primary navigation.
The theme choice stands at the foot of each console's navigation, and this
browser keeps it. A condition of the whole
console, such as lost contact or a restart under way, stands above every
screen until it ends.

## 1. Install and make first contact

The WebFlasher or documented serial installer writes a board that starts its
setup network. The flasher log and serial monitor show its generated SSID and
password. A pre-provisioned board can carry them on its label. The WebFlasher
erases the whole board, which gives it a new password. Holding the first
button at power-on opens the setup network for that boot when the password is lost.

Join the setup network and open its captive console, or `http://192.168.71.1/`.
An unconfigured device's console is onboarding alone. Choose Wi-Fi, preserve
the generated admin key, then join the network; Join waits until the owner
confirms the key is kept outside the console. A network without a password needs
the explicit open-network choice, which names what an open network exposes; a
blank password alone does not save. Back retains entered values.

The setup address and home-network hostname are different browser origins.
Remembering a key at one address does not transfer it to another. Before joining,
the owner confirms the key is saved outside this console. Device → Wi-Fi asks
for the key before it saves, so there the owner already holds it.

A transport disconnect during joining is an unconfirmed handoff, not success.
Saving Wi-Fi always restarts the device, so when the same start still answers
fifteen seconds later, the save never reached it: the console returns and says
the device stayed on its network.
Reconnect to home Wi-Fi, open the advertised device address, and enter the saved
key there. Reaching that console verifies the join. Should the join fail, the
device opens its setup network again, and its console names the cause.

## 2. Connect a bridge and player

Capture and calibration work before a bridge exists. Audio offers Connect a
bridge when no destination is configured, and Bridge explains installing one
with Home Assistant, Docker, or an existing installation. Connect a bridge
opens on a screen of its own beneath Bridge, with the search, the host and
port, and the bridge console address. Save writes a new host or port, and the
device restarts to send there; a console address alone stays in this browser.

Search the network has the device browse for about three seconds, and the
screen lists the bridges that answer, up to eight, by name and address. Use
fills the host and port and never saves them. A listed bridge is a hint, since any host on the
network can advertise one, so the owner compares the address before saving.
No answer, or a failed search, names the manual fallback: a bridge behind port
mapping or a network that blocks multicast stays reachable by its typed
address. The device searches only from the home network. First contact offers
no bridge step, and a device in recovery, back on its setup network, offers
the address form without the search.

After saving, the device distinguishes restarting, quiet input, connecting, and
sending. Only observed transmission supports Sending audio. Open the bridge
to verify reception, then copy the playback URL from the source in Sources
into an HTTP WAV player. Given the owner’s bridge console address, Bridge links
directly to the device's source in Sources; it never infers an HTTP port from the audio target. An ingress-hosted
bridge needs its player-accessible public URL configured separately. The console does not play audio. A connected player does not prove its
speakers are audible.

A bridge configured with a Sendspin server offers every source to Music
Assistant. Each source in the bridge's Sources shows its next step there:
connecting, needs pairing, input off, ready, or playing. Pairing reveals a
token once in the bridge console and pastes it into the source's setup in
Music Assistant; the token is a secret, so locking the bridge console clears
it. A ready source appears under Live Inputs. Music Assistant, not the bridge,
decides when it plays, including automatic playback when the input gets a
signal.

## 3. Set input levels

Audio places saved profiles beside the live meter. Adjust input opens a focused
editor beneath Audio with its own live meter, Save, and Discard changes. Fields
remain locked while saving. Changes apply when saved; the meter describes
applied settings while a draft is edited, and a device without a running codec
restarts to apply them. A clipping warning offers calibration, and so does the
editor. Calibration listens to the running input, so it waits, and says why,
while the device is off the home network or its codec did not start. The guide shows its steps and progress while it asks the owner to pause
the source, then play loud material. Cancelling, or leaving once the guard has
asked, restores the entry attenuation and reports a restoration failure;
completion keeps the measured result.

Profiles opens beneath Audio and keeps applied settings, never unsaved fields:
leaving the editor with changes asks first. Choosing a profile stays on Audio,
apart from managing them. Importing a profile file replaces the saved profiles
without applying any, and incompatible profiles fail with a reason.

Boards that support analog passthrough expose an immediate switch. It names the
physical output and fixed line-level route. Input gain, attenuation, calibration,
and streaming controls do not control output volume.

## 4. Operate and record

Audio distinguishes codec faults, deliberate pauses, quiet input, connection
attempts, and transmission. Resume reverses a pause. External button or API
changes update fields the user has not edited. The console never guesses which
physical source a waveform represents.

Device → Hardware names the device, shows its board, and assigns advertised
buttons and LEDs. A button or LED change applies at once. Assigning factory
reset to a button asks first, and its row keeps saying what one press does.
Choosing another built-in board or loading a board file restarts the device.
A console pause is not a persistent shutdown; restarting resumes streaming
according to firmware policy.

Device → Access replaces the admin key. The console makes a new key and shows
it once; Save waits until the owner confirms it is kept outside the console,
and this browser stays unlocked on it. Until then the old key stays in use,
and leaving asks first. Access also says whether this browser keeps the key
and forgets it on request.

Bridge Sources shows known sources, levels, connection state, playback addresses,
and reception details. Recordings separates capture from the file library.
Record this source, on a source's screen, carries that source through
unlocking; a missing source never silently becomes a different input. Storage headroom stays visible
during capture. A source appears when its device connects with streaming enabled,
including during quiet input. Start recording
before the desired passage, observe its state, then stop and save. The active
session replaces the new-recording form; another recording is an explicit action.
Finalized files offer download and confirmed deletion. Listing sessions and
files needs the bridge API token, as its API does, so a locked Recordings asks
for it instead of showing them: the one bridge read the token gates. A
deployment without recording storage names the option that adds it.
[Recordings](recordings.md) owns storage, gaps, limits, and interrupted files.

A bridge without an API token names the deployment option to configure. It never
directs the owner to an unavailable unlock action: its top bar reads Read-only,
which names the option under a resting pointer or at a press.

## 5. Enable encrypted audio

Bridge offers Set up encryption, Resume setup, or Manage, each leading to
Bridge → Encryption beneath it. Its guide shows three steps and resumes where
the device's key stands: make a credential, which the device shows once; enroll
it under bridge Settings → Audio security and require encryption there, then
verify from the device; turn it on, which restarts the device. Given the bridge
console's address, the guide links to Audio security.

The bridge mode affects every connected device. Switching the bridge before device
activation pauses cleartext audio. Failed verification does not activate the
device credential. Closing the guide retains staged progress; discarding a staged
credential does not restore the bridge mode. Recovery explicitly requires restoring
cleartext on the bridge when abandoning that transition.

Active encryption needs no routine intervention. Advanced security contains key
replacement, rollback to and retirement of the previous key, lost-key recovery,
and the switch back to cleartext, which follows the bridge's. A replacement waits
until the previous key is retired or rolled back to. After the switch back to
cleartext, the guide waits until a previous key is retired, which Advanced
security offers. The generated secret is unavailable once the guide's page
reloads, and the guide then says so and offers to discard it.
[TCP transport](tcp-transport.md) owns the protocol and API sequence.

## 6. Maintain and recover

Maintenance → Updates owns scheduling, checks, installation, rollback, and developer
installs. A check or an install shows its phase, and an install how much it has
written. Updates narrate interruption and recovery, and the device's record names
how the last install ended: finished, stopped before its restart, or gone back to
the previous image. A failed install does not claim completion. Rolling back
asks first and restarts. A page left open while the device boots another image,
after an install or a rollback, reloads that image's console onto Maintenance →
Updates once the device answers. An unsaved draft holds the reload until its
owner leaves it, and a banner offers it meanwhile. [OTA](ota.md) owns
verification and rollback behavior.

Maintenance → Diagnostics shows startup health, memory and storage headroom, and
raw status. The device log and the crash dump need the admin key, as their
endpoints do: the log follows on request, and the dump downloads for analysis or
is erased after a confirmation. Maintenance → API gives the contract and metrics
addresses and a sample write. Maintenance → Restart & reset contains restart and
confirmed factory reset, which ends on the handoff screen with the setup network
and password the device named.

A provisioned device that cannot reach its saved Wi-Fi serves a recovery console
on its setup network, not first-run commissioning. A banner names the network and
what the latest join attempt found: no such network in range, a rejected
password, or security the saved settings cannot use, such as a network that
added or removed its password. The device retries every minute and rejoins on its own; Change Wi-Fi
opens Device → Wi-Fi for a renamed network or a new password. Unlock requires
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
