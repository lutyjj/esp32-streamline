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
- **Secrets are shown once, deliberately.** The admin key appears exactly
  once per generation, with copy and remember affordances, and never again.
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

Entry: the user joins the setup network, usually on a phone, and opens
`http://192.168.71.1/`. The console recognizes an unconfigured device and
opens first-run onboarding by itself.

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

Promise: the Overview says plainly that no bridge is set and points at the
Network tab. Host and port are one form; after the save, the Bridge tile
flips to Sending as soon as packets flow, so success is observable without
leaving the console.

Exit: the Bridge tile reads Sending while music plays.

## Stage 4: calibration

Entry: the Audio tab, or the clipping callout the Overview raises when
samples hit full scale.

Promise: the wizard asks only for actions the user can perform (pause the
source, then play something loud), narrates what it hears, and cannot leave
the device worse than it found it: cancel restores the entry settings,
finish applies the measured ones. Streaming continues while it runs. It
refuses to start where it cannot work, and says why.

Exit: the loudest material plays without clipping, and the result is stated
in dB and already applied.

## Stage 5: steady state

Entry: streaming works. The device lives here for months.

Promise: the Overview answers "is everything fine?" in one glance: status,
signal, Wi-Fi, bridge. A device that came up without its audio codec says so
here — the Status reads Fault, not a false Idle, with the fix named. Streaming
follows the music, playing on signal and pausing on sustained silence, with no
user action. Nothing asks for attention unless something needs it; every
unprompted banner is real — clipping, a device unreachable, a codec that did
not start — and is dismissible or resolves itself.

Exit: none. Maintenance interrupts and returns here.

## Stage 6: maintenance and recovery

Entry: an update exists, a setting changes, the network changes, or access
is lost.

Promise:

- Updating is one button. Progress is a visible log, and the device either
  confirms the new version or rolls back by itself. A rollback is narrated
  too — the console names the version still running rather than claiming a
  success — and when the device holds a previous image, one button rolls
  back to it deliberately. [ota.md](ota.md) owns the mechanism.
- Any change that restarts the device is narrated through to recovery, and
  an overdue recovery says what to check instead of spinning forever.
- A device that cannot reach its Wi-Fi falls back to its own setup network,
  so it is never unreachable; the journey re-enters stage 2.
- A fault that appears after the network is up — an audio codec that will
  not start — keeps the device on the home network and reachable, showing
  the fault and its fix, rather than dropping to the setup network. Only a
  lost network re-enters stage 2.
- Factory reset demands explicit confirmation, states exactly what it
  erases, and lands in stage 2.
- A lost admin key means reflashing (stage 1). The README states this where
  the key is introduced; the console must not pretend otherwise.

Exit: back to stage 5, or deliberately back to an earlier stage.

## Using this document

For any change to the console or the device's visible behavior, find the
stages it touches and check their promises plus the cross-cutting list. A
change that cannot keep a promise either fixes the seam in the same PR or
files an issue naming the promise it breaks. When the intended experience
itself changes, this document changes in the same PR.
