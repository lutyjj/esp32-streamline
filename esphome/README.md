# ESPHome Spike

This is an optional ESPHome distribution path for the ESP32-A1S / ES8388 Audio
Kit. It does not require Home Assistant at runtime and uses the existing ELI1
TCP protocol and Python bridge unchanged.

## What it proves

- ESPHome configures the ES8388 and I2S input pins used by StreamLine.
- The external `streamline` component receives 48 kHz, 16-bit stereo microphone
  data, frames ELI1 packets, and sends them to the existing bridge over TCP.
- Capture and TCP remain separate: the I2S callback copies into a 32-packet,
  drop-oldest queue; a dedicated worker owns DNS, reconnects, and writes.

It intentionally does not yet expose Home Assistant entities. A successful
stream is the first acceptance criterion; HA controls are optional afterwards.

## Run

1. Start the existing bridge from the repository root:

   ```sh
   make bridge-up
   ```

2. Edit `configs/audio-kit.yaml` with Wi-Fi credentials and the bridge hostname
   or IP address. `streamline-bridge.local` is only a placeholder.

3. Validate and compile without installing ESPHome on the host:

   ```sh
   make -C esphome validate
   make -C esphome build
   ```

4. Flash and monitor the generated image with the normal ESPHome workflow.

## Hardware acceptance

This needs a board before it can be called viable. Test the following in order:

1. Bridge status shows packets and no sustained underruns after startup.
2. Ten minutes of capture has zero steady-state queue drops and network errors.
3. Stop the bridge for at least five seconds, restart it, and confirm capture
   continues and the bridge re-buffers.
4. Play left-only then right-only test audio. Confirm `swap_stereo: true` maps
   ESPHome's documented right/left callback ordering to StreamLine's L/R PCM
   contract. Flip it only if the physical result proves otherwise.
5. Compare gain, noise floor, clipping, and channel balance against the current
   v0.2.0 Rust firmware. ESPHome's ES8388 implementation is voice-oriented and
   has different gain/ALC defaults, so fidelity must be measured rather than
   assumed.

## Security

The example runs standalone and deliberately omits `api:`. If adding Home
Assistant integration, configure API encryption and use unique secrets. The
custom ELI1 TCP connection is still unencrypted and belongs on the same trusted
LAN/VLAN as the bridge.
