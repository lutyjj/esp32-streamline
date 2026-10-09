# PCM Stream Protocol

The ESP32 sends framed PCM to the bridge using a small fixed header followed by
interleaved little-endian stereo PCM. The wire format is identical regardless of
transport. The firmware carries it over a persistent TCP connection
selected as cleartext or authenticated TLS 1.3 at boot. See
[`tcp-transport.md`](tcp-transport.md) for the transport contract.

## Audio Format

```text
sample rate: 48000 Hz
channels:    2
sample size: 16-bit signed little-endian
frame size:  4 bytes
packet:      256 frames / 1024 PCM bytes, or no payload for intentional silence
```

## Header

All integer fields are little-endian.

```text
offset  size  field
0       4     magic: "ELI1"
4       1     version: 2
5       1     header size: 24
6       1     channels
7       1     bits per sample
8       4     sequence
12      4     sample rate
16      4     frames
20      4     payload bytes
```

Payload starts immediately after the 24-byte header.

Every record represents exactly 256 frames. An audio record carries 1,024 PCM
bytes. A silence record carries no payload and declares `payload bytes = 0`;
it explicitly represents an interval suppressed by the source's signal gate.
All other payload lengths are invalid. The firmware coalesces shorter hardware
reads before framing. Both sender and receiver must implement version 2;
other versions are rejected without fallback.

The deployed HTTP WAV bridge is intentionally a single-format endpoint: it accepts
only the 48 kHz, stereo, 16-bit, 256-frame format above. A different source format
must use a separate bridge instance or a future protocol version that also defines
how connected HTTP clients receive a new WAV header. This keeps the live endpoint's
media contract deterministic.

Sequence numbers follow capture time and wrap at `uint32_t`. Audio and silence
records both consume one sequence position. Capture failures, queue drops, and
failed sends can leave missing positions; intentional silence cannot.
The distinction is explicit at the source, as in the silence-suppression
principle described in [RTP's audio profile](https://www.rfc-editor.org/rfc/rfc3551.html#section-4.1).
This framing remains specific to StreamLine and is not RTP.

## Conformance vectors

[`pcm-frame-vectors.json`](pcm-frame-vectors.json) proves the Rust encoder
(`firmware/streamline/src/protocol.rs`) and the Python parser
(`bridge/src/streamline_bridge/protocol.py`) agree byte for byte. It lists valid
full 256-frame packets across the sequence range, and malformed frames the
parser must reject, one per failure category, including short packets, which
the encoder cannot represent. Both
component test suites consume it. Regenerate it with `make firmware-pcm-frame-vectors`
after a protocol change: `firmware-test` fails until the file matches the
encoder, and `bridge-test` fails until the parser matches the file.

## Receiver Playout

The HTTP bridge uses a playout buffer before publishing audio to clients. By
default it waits for about 1 second of packets, then plays one packet duration at
a time from the expected sequence number. TCP delivers admitted bytes in order.
Capture failure, queue overflow, or late arrival can still leave missing
PCM at a playout deadline. The buffer smooths timing jitter; concealment handles
those gaps.

HTTP stream clients get their own output queues. The bridge batches small PCM
packets into short writes so slow proxy/player reads are less likely to starve
the stream.

When a packet is missing at playout time, the bridge conceals the gap instead of
dropping time from the stream:

- short loss: repeat the previous packet with linear attenuation
- longer loss: emit silence
- sustained outage: stop playout after the configured silence window and wait to
  re-buffer

A received silence record plays 256 zero-valued stereo frames. It does not
increment missing-packet, concealment, or underrun accounting and keeps the
playout buffer running. A missing record remains unknown loss even when adjacent
records contain silence; the receiver never guesses that absent audio was quiet.

## Quality measurements

Each source in bridge `GET /status` exposes lifetime `missing_packets` and
`silence_packets` counters plus a `quality` object for the last minute.
`missing_packets` counts absent positions at the playout deadline, not lost
Wi-Fi frames. Late packets remain late even if TCP eventually delivers them.
An extended outage switches to rebuffering; time waiting for a new buffer does
not keep adding missing packets.

The window uses 60 one-second buckets on a monotonic clock, including the
current partial second. Events expire at bucket boundaries, with less than one
second of resolution. Status polling does not drive collection or reset it.
`observed_seconds` starts with the first event and is capped at 60. It prevents
a short run from presenting a full-minute result. Source reconnections preserve
the window; source eviction or a bridge restart clears it.

| Quality field | Meaning |
|---|---|
| `audio_packets` | Received PCM intervals played |
| `silence_packets` | Explicit source-silence intervals played |
| `missing_packets` | Absent intervals replaced by concealment |
| `late_packets` | Records received after their playout position |
| `underruns` | Outages that exhaust concealment and require rebuffering |
| `disconnects` | Producer connection endings, including deliberate maintenance |

The console target is at most one missing interval, zero underruns, and zero
connection interruptions in the window. It requires 60 seconds of observations,
a connected and ready source, and observed audio. An entirely quiet window is
reported as quiet, not as an audio-quality pass. This is a rolling observation,
not a long-term p99 claim. Player queue drops remain a separate consumer metric.
Use [device diagnostics](diagnostics.md#streaming-counters) to locate capture,
queue, or sender failures; receiver counters alone cannot identify their cause.
