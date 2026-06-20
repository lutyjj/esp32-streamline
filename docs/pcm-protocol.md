# PCM Stream Protocol

The ESP32 sends framed PCM to the bridge using a small fixed header followed by
interleaved little-endian stereo PCM. The wire format is identical regardless of
transport. The firmware carries it over a persistent TCP connection
(Rust `std::net`). See `docs/tcp-idf-transport-plan.md` for the transport design.

## Audio Format

```text
sample rate: 48000 Hz
channels:    2
sample size: 16-bit signed little-endian
frame size:  4 bytes
packet:      256 frames / 1024 bytes payload
```

## Header

All integer fields are little-endian.

```text
offset  size  field
0       4     magic: "ELI1"
4       1     version: 1
5       1     header size: 24
6       1     channels
7       1     bits per sample
8       4     sequence
12      4     sample rate
16      4     frames
20      4     payload bytes
```

Payload starts immediately after the 24-byte header.

The deployed HTTP WAV bridge is intentionally a single-format endpoint: it accepts
only the 48 kHz, stereo, 16-bit, 256-frame format above. A different source format
must use a separate bridge instance or a future protocol version that also defines
how connected HTTP clients receive a new WAV header. This keeps the live endpoint's
media contract deterministic.

Sequence numbers increment by one per packet and wrap naturally at `uint32_t`.
The receiver uses them to reorder packets, detect loss, and preserve the audio
timeline when a packet cannot be recovered before its playout deadline.

## Receiver Playout

The HTTP bridge uses a playout buffer before publishing audio to clients. By
default it waits for about 1 second of packets, then plays one packet duration at
a time from the expected sequence number. Over TCP, packets arrive ordered and
without loss, so the buffer mainly smooths timing jitter; the reordering and
loss-concealment paths matter only around disconnects.

HTTP stream clients get their own output queues. The bridge batches small PCM
packets into short writes so slow proxy/player reads are less likely to starve
the stream.

When a packet is missing at playout time, the bridge conceals the gap instead of
dropping time from the stream:

- short loss: repeat the previous packet with linear attenuation
- longer loss: emit silence
- sustained outage: stop playout after the configured silence window and wait to
  re-buffer

The `/status` endpoint reports packet, loss, concealment, underrun, late,
reordered, duplicate, and client queue drop counters.
