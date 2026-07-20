# The user journey

StreamLine has one journey: from a blank board to music on the network. This
document is the contract for that journey. Changes to the console or the
device's user-facing behavior are judged against it (see AGENTS.md, "Design
for the whole journey"): a change that breaks a stage's promise, strands the
user, or leaves a wait unexplained is not done, even if its own screen works.

The journey has six stages. Each stage names its entry, its promise, and its
exit. Commands and setup steps live in the [README quick
start](../README.md#quick-start); this document owns only the experience.

## Promises every stage keeps

- **Every wait is narrated.** When the device restarts, installs, or changes
  networks, the console says what is happening, roughly how long it takes,
  and how it knows it finished. Silence is never the signal.
- **Every failure names the next step.** An error states what failed and what
  the user does about it, in the message itself.
- **No state without an exit.** Every screen, overlay, and mode offers a way
  back to a known state: cancelling calibration restores the previous levels,
  closing onboarding lands in the full console.
- **Secrets are shown once, deliberately.** The admin key and each generated
  PCM PSK appear exactly once, with copy affordances, and never through a read
  API.
- **Reads are open, writes are locked.** Anyone on the LAN can watch status;
  every change requires the unlock window. Locked controls look locked and
  say how to unlock. [security.md](security.md) owns the trust model.

## Stage 1: flash

Entry: a blank or misconfigured board and a USB data cable.

Promise: one action, the WebFlasher's "Connect & Install" or the esptool
one-liner, produces a device with no leftover state that boots straight into
stage 2.

Exit: the board broadcasts its own `esp32-streamline-XXXX` network.

## Stage 2: first contact

Entry: the user joins the setup network, usually on a phone. The operating
system offers the setup console or opens it after detecting the captive
network. If the prompt does not appear, `http://192.168.71.1/` opens the same
console. The console recognizes an unconfigured device and opens first-run
onboarding by itself.

Promise: three steps with one decision each: pick the home Wi-Fi, save the
generated admin key, join. The key step makes losing the key hard: shown
once, copy button, remember-on-this-browser on by default. The join step
explains the handoff before it happens: this network disappears, reconnect
to your own Wi-Fi, find the device at `http://streamline-xxxx.local/`. The
device restarts only after it confirms the save; a rejected save shows the
reason inline where the user can fix it.

Exit: the device is on the home network, the user knows its address, and the
browser that commissioned it can unlock it.

Escape: closing onboarding lands in the normal console, which offers the
same capability through the Network tab.

## Stage 3: bridge hookup

Entry: a provisioned device with no stream target. Capture already runs:
meters move and calibration works before any bridge exists; only streaming
waits.

Promise: an owner who does not know what a bridge is still reaches streaming.
The Overview raises a **No bridge yet** callout whose **Set up bridge** action
opens a guided **Bridge setup** wizard. The wizard walks the whole stage: pick
where the bridge runs (a Home Assistant add-on, Docker, or one already
running), and it names that choice's install step and the address to enter;
save the target; then read the Bridge tile, which the wizard narrates from
restarting to the same **Sending** signal the tile computes, so success is
observable without leaving the console. Every step stays skippable, and the
Network tab's plain host-and-port form and the `/api/settings/target` endpoint
remain the escape hatch: the wizard only sequences them. Cleartext works
without an encryption decision during first setup.

The wizard's final step offers encryption and continues straight into the
guided **Encryption setup** sheet, the same step-dot dialog as calibration,
so every guided task reads the same way. Its steps mirror the state machine:
create the bridge credential, enroll it in the bridge console and switch the
bridge to encrypted there, verify, then activate and restart. Audio keeps
streaming through enrollment and pauses only between the bridge's switch and
the device's restart, because each side accepts exactly one protocol. A
verification failure names its cause and the next step (an unreachable port,
a bridge still in cleartext, or a credential the bridge does not accept),
keeps the retry visible, and never changes the device mode.

The Network tab's **Stream target** card owns one host and one port. A
separate **Encryption** card sits beside it (the same heading both consoles
use) and encourages the owner to turn on encryption while streaming is
cleartext. Its switch opens the same guide; a setup left mid-way shows a
"setting up" state with a resume action, and **Recovery** can discard the
pending credential, so opting in never traps the owner. Closing the sheet
keeps the staged state and says how to resume. The PSK is masked by default,
shown only on request, and never available again after the owner dismisses
it.

The bridge console mirrors the device console's lock: one masthead lock chip,
unlocked by the owner-set bridge API token, gates every bridge change:
encryption mode, device credentials, and recordings. Reads stay open. A
deployment without a token says which option to set instead of offering an
unlock that cannot succeed.

Once encryption is active, the card says no routine action is required.
Credential replacement, rollback, and recovery stay under **Advanced
security**. Routine PSK rotation is not part of the customer journey.

Exit: the Bridge tile reads Sending while music plays.

## Stage 4: input setup

Entry: the Audio tab's guide, or the clipping callout the Overview raises
when samples hit full scale.

Promise: the guide asks only for actions the user can perform (pause the
source, then play something loud), narrates what it hears, and cannot leave
the device worse than it found it: cancel restores the entry levels, finish
applies the measured ones. On a board that advertises analog passthrough,
the guide's last choice describes the route and offers it; that switch
applies immediately and is the same control Input settings carries, so
neither cancel nor finish rewrites it. Streaming continues while the guide
runs. It refuses to start where it cannot work, and says why. When several
sources need different levels, the Audio tab saves the applied settings as
named profiles and switches them live. Importing definitions never changes
the active levels. A profile from another board is rejected with the reason,
not partially applied.

Exit: the loudest material plays without clipping, and the result is stated
in dB and already applied.

## Stage 5: steady state

Entry: streaming works. The device lives here for months.

Promise: the Overview answers "is everything fine?" in one glance: status,
signal, Wi-Fi, bridge. A device that came up without its audio codec says so
here: the Status reads Fault, not a false Idle, with the fix named. Streaming
follows the music, playing on signal and pausing on sustained silence, with no
user action. Nothing asks for attention unless something needs it; every
unprompted banner is real (clipping, a device unreachable, a codec that did
not start) and is dismissible or resolves itself.

Source switching is explicit and observable: the Audio tab names the active
profile or says `Custom settings`. An external automation can activate the same
profile through the API when it knows the physical selector state. StreamLine
never guesses the source from overlapping waveform characteristics.

Board buttons act without the console: System → Buttons assigns each advertised
key a press action — start/stop streaming, switch input, restart, factory
reset — and warns in place when one press is destructive. A press never leaves
a mystery: pausing streaming turns the Overview status to **Paused** with a
callout that explains the state and offers **Resume**; a press that switches
input or steps the gain or attenuation moves the Audio tab's controls to match
within a poll, so the console never shows a level the device has left behind;
and a reboot always resumes streaming on its own.

When the selected board advertises a local analog output, Input settings
carries one **Analog passthrough** switch below its base fields, naming the
physical jack and the fixed line-level analog route. The switch is the state;
a codec fault surfaces as a callout that names the fault and how to retry.
Input gain, ADC attenuation, calibration, silence detection, and streaming do
not act as output-volume controls. Boards without the capability show no
passthrough control.

Optional lossless recording is a bridge-hosted task. The bridge page lets the
owner choose a source, start before playing it, observe whether audio has
arrived, stop and finalize, then download or delete the file. It calls the
bridge recording API and never asks the device console to manage host storage.
An interrupted capture remains available with its failure reason and gap
counters. [Lossless recordings](recordings.md) owns this flow.

Exit: none. Maintenance interrupts and returns here.

## Stage 6: maintenance and recovery

Entry: an update exists, a setting changes, the network changes, or access
is lost.

Promise:

- Updating is automatic by default, configurable as daily or weekly, waits for
  idle audio, and can be disabled. Manual checks and installs remain available.
  Progress is a visible log, and the device either
  confirms the new version or rolls back by itself. A rollback is narrated
  too (the console names the version still running rather than claiming a
  success), and when the device holds a previous image, one button rolls
  back to it deliberately. [ota.md](ota.md) owns the mechanism.
- Any change that restarts the device is narrated through to recovery, and
  an overdue recovery says what to check instead of spinning forever.
- A device that cannot reach its Wi-Fi falls back to its own setup network,
  so it is never unreachable, and rejoins on its own once the network returns.
  It keeps retrying the saved Wi-Fi in the background, so a router still
  booting after a power cut needs no user action. The setup network stays
  reachable throughout as an escape hatch, and its indicator reads
  reconnecting, not first-run. An owner who opens that setup network sees a
  recovery form, not first-run onboarding: the saved settings are prefilled,
  the form states the device is already provisioned, and the unlock sits
  inline, because a recovery write requires the admin key. The form retains
  the write-only password and admin key when their fields stay blank.
  Replacing the Wi-Fi credentials does not change the target, audio settings,
  profiles, local-output intent, name, board, or update schedule. A device
  without valid saved configuration re-enters stage 2 with clean descriptor
  defaults.
- A fault that appears after the network is up (an audio codec that will
  not start) keeps the device on the home network and reachable, showing
  the fault and its fix, rather than dropping to the setup network. Only a
  lost network re-enters stage 2.
- Factory reset demands explicit confirmation, states exactly what it
  erases, and lands in stage 2.
- A lost admin key means reflashing (stage 1). The README states this where
  the key is introduced; the console must not pretend otherwise.
- A lost PCM key keeps the HTTP console reachable. **Recover lost key** saves
  explicit cleartext for the next boot, reveals one replacement key, and then
  offers **Restart into cleartext**. The owner can provision and verify the
  replacement before activating encryption again. Key rollback and the
  prominent cleartext action remain visible exits during ordinary rotation.

Exit: back to stage 5, or deliberately back to an earlier stage.

## Using this document

For any change to the console or the device's visible behavior, find the
stages it touches and check their promises plus the cross-cutting list. A
change that cannot keep a promise either fixes the seam in the same PR or
files an issue naming the promise it breaks. When the intended experience
itself changes, this document changes in the same PR.
