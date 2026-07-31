# Device diagnostics

The device keeps its own log in memory, stores a crash dump in flash when it
panics, and serves both over the API. Reading a node needs no USB cable, no
laptop beside it, and no serial console: anything that can reach the device and
hold the admin key can read what the firmware said — including what it said
before its last restart — and pull the core dump a panic left behind.

## Read the log

```sh
curl -s -H "Authorization: Bearer $STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/logs
```

```json
{
  "current": {
    "boot": 2751483904,
    "first_sequence": 0,
    "dropped": 0,
    "text": "I (312) wifi: joined, rssi -54\nI (901) httpd: console listening on :80\n"
  },
  "previous": { "boot": 2751483903, "first_sequence": 0, "dropped": 0, "text": "" }
}
```

`current` is the running boot. `previous` is the boot before it, or `null` when
there is none to report. Both carry:

| Field | Meaning |
|---|---|
| `boot` | Identifies the run of the firmware the lines came from. Sequence numbers only mean anything within one boot, so a poller compares this to tell more lines from a restart that began counting again. |
| `text` | The held lines, oldest first, separated by newlines. A log is text and the device stores it as text, so it is served that way. |
| `first_sequence` | Position of the first line in `text` within the boot, counted from zero; each following line is one higher. A poller names the lines it already read from this. |
| `dropped` | Lines that boot produced and the buffer has already discarded. Non-zero means `text` starts later than the boot did. |

Lines are truncated at 240 bytes and carry no terminal colour codes.

Print one boot's log:

```sh
curl -s -H "Authorization: Bearer $STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/logs | jq -r .current.text
```

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
  the logging library. The log holds what led up to the panic; the dump that
  follows it lands in flash and is served separately — see
  [crash dumps](#crash-dumps).
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

## Crash dumps

A panic writes an ELF core dump to the dedicated `coredump` flash partition,
where it survives the reboot — and a rollback, which touches only the app
slots. The dump is a copy of task memory at the moment of the crash, so like
the log it sits behind the admin key.

```sh
curl -s -H "Authorization: Bearer $STREAMLINE_ADMIN_KEY" \
  http://192.0.2.10/api/coredump
```

```json
{ "present": true, "size_bytes": 23972 }
```

Download the dump and read it with ESP-IDF's `espcoredump.py`, using the
`.elf` published beside the release the device was running:

```sh
curl -s -H "Authorization: Bearer $STREAMLINE_ADMIN_KEY" \
  -o crash.bin http://192.0.2.10/api/coredump/image
espcoredump.py info_corefile -t raw -c crash.bin streamline-X.Y.Z.elf
```

`POST /api/coredump/erase` clears the stored dump and always succeeds, so a
handled crash does not shadow the next one. The device keeps one dump: a later
panic overwrites an earlier one.

A flash layout from before the `coredump` partition existed reports every
coredump endpoint `503`; the device is otherwise unaffected. OTA never
rewrites the partition table, so such units gain crash capture at their next
USB reflash ([OTA: migrating existing devices](ota.md#migrating-existing-devices)).

## In the console

**System → Developer — device log** shows both boots, with a **Follow** switch
that re-reads every few seconds and a copy button. The section needs the
settings unlock, for the same reason the endpoint needs the key.

## When serial is still the answer

Reach for [`make firmware-monitor`](../README.md#development) when the device
does not reach the network at all or when the earliest boot lines matter.
Everything else is readable over the API.
