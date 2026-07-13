# Lossless recordings

The bridge records one source's received PCM as a lossless 48 kHz, 16-bit
stereo WAV file. Recording belongs to the bridge because the bridge receives
the complete packet timeline and owns durable host storage. The device and its
console do not control bridge files.

This is an analog recording path, not a bit-perfect CD extraction. It does not
read a disc table of contents, fetch metadata, or split tracks. A user can
record a whole disc or create one file per track.

## Surface boundary

`/recordings` is a focused bridge page, not a second device console. Each
device console manages capture hardware, audio settings, Wi-Fi, and its PCM
target. The bridge page manages sessions and files owned by one bridge.

Serving bridge controls from a device would require the device page to discover
the bridge's separate HTTP address, cross browser origins, hold a second token,
and present files from sources other than that device. Keeping the API and page
on the bridge preserves one origin and one owner. Home Assistant opens the page
through the add-on's ingress Web UI; standalone users open the bridge URL
directly.

## User flow

1. The operator enables recordings and assigns a recording token in the bridge
   deployment.
2. The operator opens `/recordings`, unlocks the page with that token, chooses
   a known source, and names the recording.
3. **Start recording** puts the session in `waiting-for-audio`. The operator
   starts the source after the bridge is ready.
4. The first PCM packet starts the file. The page shows elapsed audio, file
   size, free storage, and any source-timeline gaps.
5. **Stop and save** finalizes the WAV header and makes the file downloadable.
   The recording list remains available after a bridge restart.
6. The operator downloads the file for permanent storage or deletes it from
   the bridge. Bridge storage is a working area, not a media library.

With the HACS integration installed, finalized files also appear under
**Media → StreamLine**. Home Assistant proxies playback through a fresh one-use
download ticket. [Home Assistant integration](home-assistant.md#media) owns that
browse and playback flow.

The page narrates each wait and failure. Stopping a session that received no
audio creates no empty file.

## Ownership

| Boundary | Responsibility |
| --- | --- |
| Firmware | Capture PCM, increment the packet sequence continuously, and send packets while the signal gate is open. |
| Bridge source pipeline | Admit the producer and expose received `(sequence, PCM)` packets to non-blocking consumers. |
| Recording service | Validate commands, own session states, reconstruct the source timeline, and enforce resource limits. |
| Recording store | Create, recover, list, download, and delete files inside one configured directory. |
| Recording page | Call the recording API. It owns no recording state beyond the token held in browser session storage. |
| Home Assistant integration | Call the same API for entities, actions, and media; proxy ticketed WAV playback through an authenticated Home Assistant URL. |
| Deployment adapter | Opt into writable storage and provide the recording token without placing it in process arguments. |

The recorder taps accepted packets before live playout. Live loss concealment
may repeat audio to make listening less disruptive; an archive must not invent
audio. The recorder writes received PCM once and fills missing sequence
positions with silence.

## Timeline and integrity

The first received packet defines frame zero. For every later packet, the
recorder compares its sequence with the expected next value:

- the expected sequence appends the packet;
- a forward gap inserts the exact number of silent packet frames and increments
  the gap counters;
- a duplicate is ignored and counted;
- a backwards sequence interrupts the recording because the source timeline
  may have reset.

This preserves track gaps created by the device's signal gate, including across
a TCP reconnect when the device sequence continues. The bridge interrupts a
recording rather than creating an unbounded file when one gap exceeds five
minutes, the session reaches four hours, writable storage falls below 256 MiB,
or the bounded writer queue fills. An interrupted recording remains
downloadable and states why it stopped.

The store writes `.<id>.wav.part`, repairs the finite WAV lengths, syncs the
file, and atomically renames it to `<id>.wav`. A versioned JSON manifest records
the title, source, timestamps, audio frames, gap counters, and outcome. Startup
recovers a leftover part as an interrupted WAV instead of discarding captured
audio. The WAV file remains the primary artifact; the store can rebuild a
missing manifest from it.

At 192,000 bytes per second, a recording uses about 11 MiB per minute or
659 MiB per hour before filesystem overhead.

## API

`GET /api/recordings/capabilities` is open and reports whether the deployment
enabled recording plus its format and limits. Every other recording operation
requires `Authorization: Bearer <recording-token>`.

| Operation | Contract |
| --- | --- |
| `GET /api/recordings` | List active and saved recordings plus storage availability. |
| `POST /api/recordings` | Start `{ "source": "192.0.2.10", "title": "Album disc 1" }`. One session may run per source. |
| `POST /api/recordings/{id}/stop` | Detach the packet tap, drain its queue, and finalize or discard the session. |
| `POST /api/recordings/{id}/download-ticket` | Create a one-use download URL that expires after 60 seconds. |
| `GET /api/recordings/{id}/file` | Download with bearer authentication or a valid one-use ticket. |
| `DELETE /api/recordings/{id}` | Delete an inactive WAV and its manifest. |

The service returns named states: `waiting-for-audio`, `recording`,
`finalizing`, `complete`, `interrupted`, and `empty`. Errors use a stable code
and a message that names the next action.

## Deployment and security

Standalone containers enable the feature with `--recordings-dir`; the path
must be a writable mounted directory. `STREAMLINE_RECORDING_TOKEN` must be set
to at least 16 characters when the directory is configured. Compose owns the
writable `/recordings` volume while the rest of the container stays read-only.
Recording stays disabled when `STREAMLINE_RECORDINGS_DIR` is empty.

The Home Assistant add-on exposes an opt-in `recordings_enabled` option and a
password-type `recording_token` option. It stores files in its private
`/data/recordings` directory without mapping another writable host folder.
Recordings survive add-on restarts and updates, but the add-on excludes them
from Home Assistant backups. Restoring the add-on or uninstalling it removes
these working files. Download every completed WAV that must be retained.

The recording page stores the token in `sessionStorage`, never in a URL,
cookie, file name, status response, or log. A bearer-authenticated request
creates each one-use, 60-second download ticket, so the browser can stream a
large WAV through its native download path without exposing the recording
token or buffering the file in page memory. Bearer authentication protects all
other recording operations. The bridge still serves plain HTTP on a trusted
LAN; a reverse proxy must terminate TLS before access from another trust zone.

## Non-goals

- device-console controls for bridge storage
- bit-perfect digital CD extraction
- automatic track detection, splitting, or metadata lookup
- encoding or transcoding while capture is active
- editing, normalization, or noise reduction

These jobs can consume the finalized WAV without changing the capture
contract.
