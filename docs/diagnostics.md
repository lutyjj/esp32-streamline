# Device diagnostics

The device keeps its own log in memory and serves it over the API. Reading a
node needs no USB cable, no laptop beside it, and no serial console: anything
that can reach the device and hold the admin key can read what the firmware
said, including what it said before its last restart.

## Read the log

```sh
curl -s -H "Authorization: Bearer $STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/logs
```

```json
{
  "current": {
    "boot": 2751483904,
    "lines": [
      { "sequence": 0, "text": "I (312) wifi: joined, rssi -54" },
      { "sequence": 1, "text": "I (901) httpd: console listening on :80" }
    ],
    "dropped": 0
  },
  "previous": { "boot": 2751483903, "lines": [], "dropped": 0 }
}
```

`current` is the running boot. `previous` is the boot before it, or `null` when
there is none to report. Both carry:

| Field | Meaning |
|---|---|
| `boot` | Identifies the run of the firmware the lines came from. Sequence numbers only mean anything within one boot, so a poller compares this to tell more lines from a restart that began counting again. |
| `lines[].sequence` | Position within that boot, counted from zero. A poller compares it to tell new lines from lines it already read. |
| `lines[].text` | The rendered line, terminal colour codes removed, truncated at 240 bytes. |
| `dropped` | Lines that boot produced and the buffer has already discarded. Non-zero means `lines` starts later than the boot did. |

The endpoint requires the admin key. Log lines name the network the device
joined, the bridge it talks to, and the addresses it reached, so unlike the
other reads it is not open.

## What reaches the log

Every line the firmware and ESP-IDF write once capture starts: Wi-Fi
association and loss, the codec bring-up, TLS handshake failures, OTA progress
and its verdict, and each warning any component raises. Serial output is
unchanged, so `make firmware-monitor` still shows the same lines.

Allocation failures are recorded before the abort that follows them, with the
size requested, the caller, the free heap, and the largest free block. On a
device that runs out of memory that record is the diagnosis, and it survives
into the next boot.

## What does not

- **The first lines of a boot.** The bootloader and the ESP-IDF startup run
  before the firmware installs its capture, so those reach the UART only.
- **Panic backtraces.** The panic handler writes straight to the UART, below
  the logging library. The log holds what led up to the panic, not the dump
  that follows it. Recovering that needs `CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH`
  and a `coredump` partition, which is a partition-table change and therefore a
  serial reflash.
- **Anything after a power cycle.** Retention across a restart relies on RAM
  the reset does not clear. Pulling power clears it, so `previous` is `null`
  after one.

## Sizes

The running boot keeps 4 KB of lines, the previous boot 2 KB, both allocated
statically at build time. They cost the same whether or not anyone reads them
and never fragment the heap the audio path needs. When a buffer fills, the
oldest whole lines are discarded and counted in `dropped`.

Read often enough and the reader keeps more history than the device does: the
console merges each read into what it already holds, so lines that scrolled out
of the device's buffer between two reads stay on screen.

## In the console

**System → Developer — device log** shows both boots, with a **Follow** switch
that re-reads every few seconds and a copy button. The section needs the
settings unlock, for the same reason the endpoint needs the key.

## When serial is still the answer

Reach for [`make firmware-monitor`](../README.md#development) when the device
does not reach the network at all, when the earliest boot lines matter, or when
a panic dump is what you need. Everything else is now readable over the API.
