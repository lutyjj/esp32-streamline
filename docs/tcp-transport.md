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

- capture: I2S RX on core 1, FreeRTOS priority 3
- transport: TCP sender on core 1, FreeRTOS priority 2
- queue: 32 fixed-capacity packets; on pressure, discard the oldest packet
- packet: 24-byte header plus up to 1,024 PCM bytes, coalesced into one write
- cleartext connect/write deadline: 250 ms with `TCP_NODELAY`
- TLS handshake and socket deadline: 2 seconds through ESP-TLS

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
rollback, retirement, and recovery.

The bridge stores a bounded versioned key map in a private `0600` file. Updates
use a durable atomic replacement. The API lists only key ids. Its key mutation
endpoints require the separate transport API token.

## Enable encryption

The bridge and device cannot change the protocol on one port atomically. Plan a
short interruption while they switch. If one bridge serves several devices,
switch those devices together or run separate bridge instances during the
migration.

For standalone Compose, prepare these private environment values:

```dotenv
STREAMLINE_TLS_ENABLED=true
STREAMLINE_TRANSPORT_API_TOKEN=replace-with-at-least-16-random-characters
```

For Home Assistant, set `tls_enabled` and `transport_api_token` in the add-on
configuration.

Open the device console and the bridge console:

1. In the device **Network → Stream target** card, select **Encrypt transport**
   and **Generate bridge credential**. Copy the one-time key id and PSK.
2. Enable TLS and restart the bridge. Its one PCM port now rejects cleartext, so
   audio pauses until the device activates TLS.
3. In the bridge **PCM transport** section, unlock with the transport API token
   and provision that key id and PSK.
4. On the device, select **Verify with bridge**. The device performs a real TLS
   handshake on the configured target port and marks the pending credential
   verified only after it succeeds. Fix a wrong bridge key or mode and retry.
5. Select **Activate encryption**. Activation promotes the verified key,
   selects `tls-psk`, and restarts the device as one failure-atomic state
   transition.
6. Confirm the bridge reports the source by key id over `tls-psk` and audio
   continues.

To back out before activation, select **Recovery options → Discard pending
credential** or `POST /api/transport/keys/discard`. The device abandons the
staged key, stays on cleartext, and returns to the opt-in state; remove any
already-provisioned bridge key with `DELETE /api/transport/keys/<key-id>`.

Every console operation is available through the APIs. The equivalent key
provisioning sequence uses placeholders only:

```sh
curl -X POST \
  -H 'Authorization: Bearer <device-admin-key>' \
  http://192.0.2.10/api/transport/keys/stage

curl -X PUT \
  -H 'Authorization: Bearer <bridge-transport-token>' \
  -H 'Content-Type: application/json' \
  -d '{"psk":"<64-lowercase-hex-characters>"}' \
  http://192.0.2.20:8088/api/transport/keys/<key-id>

curl -X POST \
  -H 'Authorization: Bearer <device-admin-key>' \
  http://192.0.2.10/api/transport/keys/verify

curl -X POST \
  -H 'Authorization: Bearer <device-admin-key>' \
  http://192.0.2.10/api/transport/keys/activate
```

Switch the bridge to TLS between staging the device credential and provisioning
it through the bridge API. The stage response supplies the key id and PSK for
the bridge request. Do not put a real response in shell history, source
control, an issue, or a PR.

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
pending key, and reveals the replacement PSK once. While the bridge is still in
TLS mode, provision the replacement. Switch the bridge to cleartext, restart
the device into cleartext, then repeat the normal coordinated TLS cutover.

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

Switch the bridge to cleartext first by setting `tls_enabled=false` and
restarting it. Then disable encryption in the device's **Advanced security**
controls. The device restarts in cleartext on the same host and port. The gap
between those actions is expected; neither side accepts the other protocol.

## Hardware smoke criteria

For a ten-minute local run, expect continuous authenticated source identity,
zero network errors, a bridge with no underruns after startup, and no recurring
heap decline. Qualification also covers bridge restart, Wi-Fi reconnect, device
reboot, wrong and unknown keys, downgrade rejection, rotation, rollback,
recovery, and restoration of the original device state.
