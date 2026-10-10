# PCM transport

The firmware sends the [ELI1 PCM frame](pcm-protocol.md) over one
persistent TCP byte stream. It supports explicit `cleartext` and `tls-psk`
modes. Cleartext is the compatibility default; encrypted mode is owner-enabled
after a device proves its staged key against the bridge.

[`pcm-transport.json`](pcm-transport.json) owns the shared machine-readable
values. Firmware and bridge tests compare their constants to that file.

## Protected session

Encrypted mode requires this exact profile:

- TLS 1.3 external PSK with ephemeral ECDHE (`psk_dhe_ke`)
- `TLS_AES_128_GCM_SHA256`
- one independent random 32-byte PSK per device
- client identity `eli1:1:<key-id>`, where the key id matches
  `eli1-[0-9a-f]{32}`
- no session tickets or early data

The bridge and device use one target port, TCP `39000` by default. Each side
selects exactly one mode. A cleartext bridge rejects TLS; a TLS bridge rejects
cleartext. An encrypted device reconnects only with the same active identity
and key. Authentication, negotiation, or I/O failure drops that session and
retries TLS; the device never tries cleartext automatically.

The bridge completes the TLS handshake and checks the exact version and cipher
before it admits a source. The authenticated key id becomes the source id.
`source_allow` still checks the peer IPv4 address as a deployment boundary, but
an address does not authenticate a TLS source.

TLS authenticates and encrypts every ELI1 byte. AEAD record sequence numbers
reject record replay and reordering within a session. Fresh handshake randoms,
ephemeral ECDHE, and the TLS transcript prevent a captured session or handshake
from being accepted as a new session. There is no 0-RTT data. Unsupported
contract versions, identities, TLS versions, ciphers, and keys fail before
source admission.

## Runtime boundaries

- capture: I2S RX on core 1, FreeRTOS priority 7
- audio clock: dedicated APLL, 48 kHz stereo with 12.288 MHz MCLK
- transport: TCP sender on core 1, FreeRTOS priority 6, 12 KiB task stack
  shared by batching and TLS handshakes
- both audio tasks outrank httpd (priority 5); shared locks and network work
  can still delay streaming
- radio: Wi-Fi power save and transmit aggregation off; frames receive
  individual acknowledgements
- TCP: 11,520-byte send buffers and receive windows;
  Wi-Fi uses the SDK's default buffer pools
- TCP timers: 25 ms fast ticks and 50 ms retransmission ticks; the initial
  retransmission timeout stays at the SDK's 1.5 seconds, then adapts to measured
  round-trip time
- scheduling: both PCM transports request IP precedence 4 (`IP_TOS=0x80`),
  which ESP-IDF maps to the Wi-Fi media access category
- capture reads: 20 ms per DMA wait; failures back off for 10 ms
- DMA: six buffers of 240 stereo frames, or 30 ms at 48 kHz
- queue: 48 packets (256 ms) in six fixed-capacity allocations; on pressure,
  discard the oldest packet. Each allocation holds eight packets so resuming
  after HTTPS needs only 8,384 contiguous bytes per allocation
- send admission: retain queued audio through network delays and connection
  setup; check streaming controls again before writing
- pause: stop enqueueing and admitting sends, close the connection, discard
  queued audio, and release queue and batch storage; an already-started write
  may finish
- packet: 24-byte header plus 1,024 PCM bytes for audio, or only the header
  for intentional silence
- send batch: up to four whole packets in one write; collect for at most
  40 ms after the first packet, then flush even if capture has stopped;
  the sender reuses a 4,192-byte internal-RAM buffer
- TLS outgoing content budget: 4,208 bytes, including the inner content type
  and padding; the adapter verifies that the negotiated payload capacity holds
  one complete send batch. Dynamic record buffers release this allocation
  after use
- `TCP_NODELAY` on both transports: flush a partial batch without waiting for
  another acknowledgement; full batches allow TCP to fill network segments
- cleartext connect and individual socket-write timeouts: 250 ms;
  completing a batch can require several writes
- TLS handshake and socket-operation timeouts: 2 seconds through ESP-TLS
- a successful send slower than 100 ms counts as a send stall
  (`send_stalls_total` and `longest_send_stall_ms` in `/api/status` metrics)
  and logs a warning to help diagnose a stalling radio link

Capture measures elapsed time between complete packets. Beyond the DMA
allowance, it advances the sequence by estimated missing packet intervals
and discards partial audio while preserving stereo frame alignment. This is
a timing estimate, not an exact DMA overrun count. Two seconds without a
complete packet clears playing status, including when reads return fragments.

Live audio changes relearn the input's noise floor for playback status.
Detection never suppresses captured samples. Only all-zero packets use
header-only silence records.

Queued audio survives connection setup and slow sends within the queue's
fixed capacity. A failed send discards that batch and backs off for 250 ms
before processing the queue.

An established producer keeps its TCP connection during silence.
The bridge's source idle timeout bounds the first packet and incomplete
frames. Between complete packets, native TCP keepalive checks the connection
alongside the regular silence records. Its probe interval rounds the configured timeout up to
whole seconds, with a one-second minimum; three unanswered probes close a
dead connection. PCM and header-only silence use the same connection.

The firmware chooses the transport once while composing the network task.
Cleartext uses Rust `std::net` over lwIP. TLS uses ESP-TLS only in the adapter;
the core key policy and persistence have no ESP-IDF dependency. The bridge
likewise authenticates a socket before its source registry or media pipeline
can observe it.

## Key state

The device stores two key slots plus active and pending markers. Read APIs
return key ids and state, never PSKs. A PSK appears once in the response that
creates it. The admin key and PCM PSK are independent.

Each lifecycle write saves a complete inactive state generation, then switches
one marker. Power loss before that marker leaves the prior generation active.
The failure-atomic transitions are stage, verify, activate, discard, rotation,
rollback, retirement, and recovery. Verification proves the pending key
against the configured stream target, so changing the target host or port
voids it; activation then demands a fresh verify against the new bridge.

The bridge persists its listener mode and a bounded versioned key map together
in a private `0600` state file. Updates use a durable atomic replacement. The
API lists only key ids. Mode and key mutations require the bridge API token
([bridge reference](bridge.md)), and key enrollment works in either mode, so a
credential can be in place before the switch. A mutation persists first and
then closes the sessions it invalidates: replacing or deleting a key drops
that key's live TLS producers while unrelated sessions stay connected, so a
retired credential cannot keep source control by holding its connection open.

## Enable encryption

The bridge and device cannot change the protocol on one port atomically. The
consoles sequence the switch so audio pauses only between the bridge's mode
change and the device's restart. If one bridge serves several devices, switch
those devices together or run separate bridge instances during the migration.

Prerequisite: a bridge API token. For standalone Compose set
`STREAMLINE_API_TOKEN` to at least 16 private characters; for Home Assistant
set `api_token` in the add-on configuration.

Open the device console and the bridge console:

1. In device **Settings → Encrypted audio**, select **Set up encryption**,
   then **Generate bridge credential**. Copy the one-time
   key id and PSK. Cleartext keeps streaming.
2. In bridge **Settings → Audio security**, unlock with the API token and add that key id
   and PSK under **Device credentials**. Audio still streams.
3. Select **Require encryption** and confirm the bridge-wide change. The one
   PCM port now rejects cleartext, so audio pauses until the device follows.
4. On the device, select **Verify with bridge**. The device performs a real TLS
   handshake on the configured target port and marks the pending credential
   verified only after it succeeds. A failure names what to fix: an
   unreachable port, a bridge still in cleartext, or a credential the bridge
   does not accept.
5. Select **Activate encryption**. Activation promotes the verified key,
   selects `tls-psk`, and restarts the device as one failure-atomic state
   transition. Audio resumes encrypted.
6. Confirm the bridge reports the source by key id over `tls-psk`.

To back out before activation, select **Recovery → Discard pending
credential** or `POST /api/transport/keys/discard`, and switch the bridge back
to cleartext. The device abandons the staged key, stays on cleartext, and
returns to the opt-in state; remove any already-enrolled bridge key with
`DELETE /api/transport/keys/<key-id>`.

Every console operation is available through the APIs. The equivalent sequence
uses placeholders only:

```sh
curl -X POST \
  --digest -u "admin:$STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/transport/keys/stage

curl -X PUT \
  -H 'Authorization: Bearer <bridge-api-token>' \
  -H 'Content-Type: application/json' \
  -d '{"psk":"<64-lowercase-hex-characters>"}' \
  http://192.0.2.20:8088/api/transport/keys/<key-id>

curl -X PUT \
  -H 'Authorization: Bearer <bridge-api-token>' \
  -H 'Content-Type: application/json' \
  -d '{"mode":"tls-psk"}' \
  http://192.0.2.20:8088/api/transport/mode

curl -X POST \
  --digest -u "admin:$STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/transport/keys/verify

curl -X POST \
  --digest -u "admin:$STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/transport/keys/activate
```

The stage response supplies the key id and PSK for the bridge request. Do not
put a real response in shell history, source control, an issue, or a PR.

## Replace and retire

Routine rotation is unnecessary: ephemeral ECDHE gives each session fresh
traffic keys and forward secrecy. Replace the bridge credential after suspected
exposure, device ownership transfer, or an explicit recovery. Replacement uses
the same stage, bridge provision, verify, and activate sequence without
changing the bridge mode.
Activation retains the former key as the device rollback key. Keep both bridge
keys during a bounded observation window.

- `POST /api/transport/keys/rollback` switches to the former key and restarts.
- `POST /api/transport/keys/retire` removes the device rollback key.
- `DELETE /api/transport/keys/<key-id>` removes the corresponding bridge key.

Retire only after the active key has survived the required restarts and
playback checks. Device retirement and bridge deletion are deliberately
separate authenticated operations, so either side can be rolled back before
the window closes.

## Recover

If the active or pending PCM key is lost, open the device console with its admin
key and select **Replace lost credential** under **Advanced security**. The
recovery write selects cleartext for the next boot, replaces any unusable
pending key, and reveals the replacement PSK once. Enroll the replacement in
the bridge console, switch the bridge to cleartext, restart the device into
cleartext, then repeat the normal coordinated TLS cutover.

The programmable recovery is:

```sh
curl -X POST \
  --digest -u "admin:$STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/transport/recover

curl -X POST \
  --digest -u "admin:$STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/restart
```

A lost admin key requires the documented physical reflash recovery. The PCM
transport cannot bypass HTTP administration.

## Switch back to cleartext

Switch the bridge to cleartext first, in its console or with
`PUT /api/transport/mode`. Then disable encryption in the device's **Advanced
security** controls. The device restarts in cleartext on the same host and
port. The gap between those actions is expected; neither side accepts the
other protocol.

## Hardware smoke criteria

Use continuous input for a ten-minute local run. Expect authenticated source identity,
zero network errors, a bridge with no underruns after startup, and no recurring
heap decline. Exclude deliberate maintenance pauses and verify
[explicit silence accounting](pcm-protocol.md#quality-measurements).
Qualification also covers bridge restart, Wi-Fi reconnect, device
reboot, wrong and unknown keys, downgrade rejection, rotation, rollback,
recovery, and restoration of the original device state.
