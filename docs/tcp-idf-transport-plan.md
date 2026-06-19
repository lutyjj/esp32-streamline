# TCP Transport Design Record

Status: **stable.** The TCP transport replaced the UDP sender with a raw
lwIP TCP socket transport. The findings below are kept as a record of what was
tried, what broke, and what actually mattered.

## Problem

The UDP path can work cleanly on a good LAN, but it cannot recover missing packets. A TCP sender should give us ordered delivery and retransmission, but the first Arduino `WiFiClient` attempt was not stable:

- `WiFiClient.write()` periodically stalled with `EAGAIN`-like errors.
- The capture queue filled, then every new audio packet was dropped.
- Active HTTP handling on the ESP appeared to compete with the stream socket.
- Larger packets reduced send rate but increased stack/heap pressure.

The failure looked like ESP-side socket/runtime pressure, not an I2S capture problem.

## Goals

- Keep capture deterministic: no I2S read drops while the network task stalls briefly.
- Use TCP without Arduino `WiFiClient`.
- Remove the ESP web server from the streaming hot path.
- Keep enough observability to prove where drops happen.
- Keep the host bridge simple: one TCP audio input, existing HTTP WAV output.

## Non-Goals

- No Music Assistant provider work.
- No deployment-specific integration wiring.
- No codec/compression yet.
- No Sendspin/Snapcast/Icecast changes.
- No compatibility aliases for older config keys.

> Note (post-experiment): the I2S modernization non-goal still stands; the legacy
> `driver/i2s.h` API remains in use and is the natural next experiment.

## Firmware Shape

1. Boot and load config from NVS/local defaults.
2. Connect Wi-Fi.
3. If configuration is invalid, start setup AP and web UI.
4. If configuration is valid, start the web server (toggleable; see Findings).
5. Start I2S capture task pinned away from Wi-Fi.
6. Start raw lwIP/BSD socket TCP sender task.
7. Send framed PCM packets over one persistent TCP connection.
8. Reconnect on socket failure.

> Note (post-experiment): the original plan kept the web server off in streaming
> mode, suspecting it competed with the audio hot path. That assumption was
> invalidated. With capture and network split into separate higher-priority
> FreeRTOS tasks, `loop()` (and therefore `server.handleClient()`) runs at the
> lowest priority on core 1 and is preempted by both audio tasks, so it cannot
> starve the stream. The web server is back on by default, behind a toggle.

## Transport Shape

Each TCP record uses the existing `ELI1` packet header followed by packed stereo PCM samples.

The sender uses:

- `socket(AF_INET, SOCK_STREAM, IPPROTO_IP)`
- `setsockopt(TCP_NODELAY)`
- optional `SO_SNDTIMEO`
- `send()` in bounded chunks
- explicit handling for `EINTR`, `EAGAIN`, `EWOULDBLOCK`, and disconnects

The sender must never block the capture task directly. Capture writes into a bounded FreeRTOS queue. If the queue fills, the oldest packet is dropped and this is counted as `queue_drops`.

## Host Bridge Shape

The bridge listens for a single TCP stream on the port previously used for UDP, then feeds the existing `AudioHub`. The HTTP WAV output stays unchanged.

Expected CLI:

```sh
make bridge-run BRIDGE_ARGS='\
  --tcp-bind 0.0.0.0 \
  --tcp-port 39000 \
  --http-bind 0.0.0.0 \
  --http-port 8088'
```

The old UDP input was removed on this branch; the bridge is TCP-only.

## I2S Modernization

The current firmware uses `driver/i2s.h`, which is the legacy ESP-IDF I2S API. That is worth migrating, but it should be a second experiment after raw TCP is stable.

Reason: the stable UDP build proves I2S capture is currently good enough. Changing I2S and TCP at the same time would make regressions harder to isolate.

Target follow-up:

- Move from `driver/i2s.h` to `driver/i2s_std.h`.
- Use `i2s_new_channel()`, `i2s_channel_init_std_mode()`, `i2s_channel_enable()`, and `i2s_channel_read()`.
- Keep the same ES8388 codec setup unless the audio driver library blocks the migration.

## Success Criteria

For a 10 minute local run:

- ESP remains reachable by serial.
- Bridge `underruns == 0` after startup.
- Bridge `lost == 0`.
- Firmware `queue_drops == 0` after startup.
- Firmware `network_errors == 0` in steady state.
- No recurring heap decline.

## Findings (post-experiment)

The transport hit all success criteria after three fixes, each found by
instrumenting the network task with `esp_timer` timing and EAGAIN counters:

1. **Queue allocation failure.** `AUDIO_QUEUE_DEPTH=128` needed ~131 KB of
   contiguous RAM and failed after WiFi/codec init. Reduced to 32 (~170 ms of
   slack), which allocates cleanly and is plenty for a streaming pipeline with a
   dedicated draining task.

2. **Network task pinned to the wrong core.** `CONFIG_LWIP_TCPIP_TASK_AFFINITY`
   pins the lwIP tcpip thread to core 0. Pinning `network_task` to core 0 as well
   serialized "hand bytes to lwIP" with "lwIP hands bytes to WiFi" on one core,
   capping throughput at ~140 pkt/s with constant `EAGAIN`. Moving `network_task`
   to core 1 (away from lwIP) eliminated the contention; `EAGAIN` went to zero.

3. **Per-packet send fragmentation.** `TCP_SEND_CHUNK_BYTES=1024` split each
   1048-byte packet (24-byte header + 1024-byte payload) into two `send()` calls,
   and with `TCP_NODELAY` each call flushed a separate TCP segment. Bumping the
   chunk size to 1460 (one full packet per `send()`) halved per-packet overhead.
   Coalescing header+payload into a single buffer before the call also avoided
   emitting a useless 24-byte header-only segment.

### Measured steady state

- 187 pkt/s (full 48 kHz / 256-frame capture rate)
- `queue_drops == 0`, `network_errors == 0` after startup
- `send_ms ≈ 520`, `blocked_ms ≈ 480` (large headroom)
- heap stable at ~180 KB, no recurring decline
- bridge `underruns == 0`, `late == 0`, `duplicate == 0`, `reordered == 0`

### Diagnostics

The timing/EAGAIN instrumentation was promoted to a first-class toggleable mode
rather than removed: `STREAMLINE_DIAGNOSTICS` build flag (default off) plus a
runtime `diag` serial command persisted to NVS. Timing is always collected
(negligible cost, keeps the send hot path branchless); only reporting is gated.

## Rollback Criteria

Rollback or park this branch if:

- TCP sender stalls for more than one second in normal LAN conditions.
- Queue drops continue in steady state.
- Web/status access destabilizes the stream even with streaming-mode web disabled.
- Raw sockets behave no better than Arduino `WiFiClient`.

None of these triggered in steady state.
