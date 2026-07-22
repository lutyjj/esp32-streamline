# PCM transport

The firmware sends the unchanged [ELI1 PCM frame](pcm-protocol.md) over one
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
- transport: TCP sender on core 1, FreeRTOS priority 6
- both audio tasks outrank httpd (priority 5), so HTTP load cannot starve the
  stream into dropping packets
- radio: Wi-Fi power save off, so round-trip time stays low enough that the
  send window sustains the capture bitrate
- queue: 32 fixed-capacity packets; on pressure, discard the oldest packet
- packet: 24-byte header plus up to 1,024 PCM bytes, coalesced into one write
- `TCP_NODELAY` on both transports: each packet is one sub-MSS write on the
  capture clock, and Nagle would hold every write for the previous one's
  acknowledgement — a packet per round trip instead of per capture interval,
  which the queue drops as the difference
- cleartext connect/write deadline: 250 ms
- TLS handshake and socket deadline: 2 seconds through ESP-TLS
- a successful send slower than 100 ms counts as a send stall
  (`send_stalls_total` and `longest_send_stall_ms` in `/api/status` metrics)
  and logs a warning — the early signature of a stalling radio link

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

1. In the device **Network → Stream target** card, turn on **Encrypt
   transport** and select **Generate bridge credential**. Copy the one-time
   key id and PSK. Cleartext keeps streaming.
2. In the bridge console, unlock with the bridge API token and add that key id
   and PSK under **Device credentials**. Audio still streams.
3. In the bridge **PCM transport** section, switch on encrypted mode. The one
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
  -H 'Authorization: Bearer <device-admin-key>' \
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
  -H 'Authorization: Bearer <device-admin-key>' \
  http://192.0.2.10/api/transport/keys/verify

curl -X POST \
  -H 'Authorization: Bearer <device-admin-key>' \
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
  -H 'Authorization: Bearer <device-admin-key>' \
  http://192.0.2.10/api/transport/recover

curl -X POST \
  -H 'Authorization: Bearer <device-admin-key>' \
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

For a ten-minute local run, expect continuous authenticated source identity,
zero network errors, a bridge with no underruns after startup, and no recurring
heap decline. Qualification also covers bridge restart, Wi-Fi reconnect, device
reboot, wrong and unknown keys, downgrade rejection, rotation, rollback,
recovery, and restoration of the original device state.
