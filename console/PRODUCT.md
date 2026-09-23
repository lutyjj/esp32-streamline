# Console product context

StreamLine connects a physical audio source to network players. Its owner can
flash a board and configure home Wi-Fi, but should not need to understand codecs,
PCM, transport keys, or packet buffering to listen.

The device console answers whether the input is working and lets the owner
switch saved input settings. The bridge console receives that audio, supplies
the player address, and optionally records it. Neither console can confirm
that a speaker is playing. The [user journey](../docs/user-journey.md) owns the
complete setup, listening, maintenance, and recovery promises.

Routine use must fit a phone: check the signal, select a profile, resume audio,
or save a recording. Tuning must keep controls beside live feedback. Setup and
maintenance need deliberate entry points, clear consequences, and an exit.

Use plain action labels and consistent terms across both consoles. Read facts
from the generated API contracts. Preserve unavailable, quiet, paused, and
fault states as distinct states. Keep applied settings distinct from drafts.

The device console ships inside firmware as one offline HTML file. Use the
existing Preact runtime, CSS, and bundled font. No remote assets or UI framework
are required. Desktop and phone layouts support light and dark themes,
keyboard operation, enlarged text, and reduced motion.
