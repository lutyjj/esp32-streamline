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

The cleartext listener defaults to TCP `39000`; the encrypted listener defaults
to TCP `39001`. They are independent listeners. A device selects one mode and
port at boot. An encrypted device reconnects only to the encrypted port with
the same active identity and key. Authentication, negotiation, or I/O failure
drops that session and retries it; the device never tries cleartext
automatically.

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
The failure-atomic transitions are stage, verify, activate, rotation, rollback,
retirement, and recovery.

The bridge stores a bounded versioned key map in a private `0600` file. Updates
use a durable atomic replacement. The API lists only key ids. Its key mutation
endpoints require the separate transport API token.

## Enable encryption

First enable the encrypted bridge listener while leaving cleartext enabled.
For standalone Compose, set these private environment values and recreate the
service:

```dotenv
STREAMLINE_TLS_ENABLED=true
STREAMLINE_CLEARTEXT_ENABLED=true
STREAMLINE_TRANSPORT_API_TOKEN=replace-with-at-least-16-random-characters
```

For Home Assistant, set `tls_enabled`, `cleartext_enabled`, `tls_port`, and
`transport_api_token` in the add-on configuration, then restart the add-on.

Open the device console and the bridge console:

1. In the device **Network → PCM transport** card, select **Generate encrypted
   key**. Copy the one-time key id and PSK.
2. In the bridge **PCM transport** section, unlock with the transport API token
   and provision that key id and PSK.
3. On the device, select **Verify with bridge**. The device performs a real TLS
   handshake on the encrypted port and marks the pending key verified only
   after it succeeds. Fix a wrong bridge key or listener setting and retry; the
   device stays on cleartext.
4. Select **Activate encryption**. Activation promotes the verified key,
   selects `tls-psk`, and restarts the device as one failure-atomic state
   transition.
5. Confirm the bridge reports the source by key id over `tls-psk` and audio
   continues.

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

The first response supplies the key id and PSK for the second request. Do not
put a real response in shell history, source control, an issue, or a PR.

## Rotate and retire

Rotation uses the same stage, bridge provision, verify, and activate sequence.
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
key and select **Recover lost key**. The recovery write selects cleartext for
the next boot, replaces any unusable pending key, and reveals the replacement
PSK once. Copy it, provision it on the bridge, then select **Restart into
cleartext**. Repeat the normal verification and activation flow.

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

## Retire cleartext

Keep both bridge listeners only while legacy devices are migrating. After every
device reports `tls-psk` and has passed playback and restart checks, set
`cleartext_enabled=false` and restart the bridge. An encrypted device is
unaffected because it never uses the cleartext port. Re-enable the listener
only as an explicit owner recovery action.

## Hardware smoke criteria

For a ten-minute local run, expect continuous authenticated source identity,
zero network errors, a bridge with no underruns after startup, and no recurring
heap decline. Qualification also covers bridge restart, Wi-Fi reconnect, device
reboot, wrong and unknown keys, downgrade rejection, rotation, rollback,
recovery, and restoration of the original device state.
