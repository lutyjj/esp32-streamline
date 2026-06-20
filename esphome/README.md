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

## Forked es8388 codec

ESPHome's built-in `es8388` component is tuned for voice recording: it
force-enables ALC (up to +23.5 dB auto-gain) and a noise gate, and exposes no
configuration for gain or ALC ([docs] list only `address` and `i2c_id`). A
line-level source clips constantly under that AGC. `components/es8388` vendors
the component and adds two options, defaulting to a clean line-in:

- `auto_gain` (bool, default `false`) — enable the ALC register block
- `mic_gain` (`0dB`..`24dB` in 3 dB steps, default `0dB`) — fixed ADC input PGA

`audio-kit.yaml` shadows the built-in component through `external_components` and
captures at 0 dB with ALC off. Measured on hardware: full-scale clipping on both
channels before the fork, zero clipped samples after.

[docs]: https://esphome.io/components/audio_dac/es8388/

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
4. Play left-only then right-only test audio. The i2s_audio microphone documents
   stereo data as right-then-left, so `swap_stereo: true` maps it to StreamLine's
   left-then-right PCM contract. Flip it only if the physical result proves
   otherwise.
5. Compare gain, noise floor, clipping, and channel balance against the current
   v0.2.0 Rust firmware. With the forked codec (`auto_gain: false`,
   `mic_gain: 0dB`) the ADC path matches the Rust/0.1.2 fixed-gain config; raise
   `mic_gain` for weaker sources.

## Security

The example runs standalone and deliberately omits `api:`. If adding Home
Assistant integration, configure API encryption and use unique secrets. The
custom ELI1 TCP connection is still unencrypted and belongs on the same trusted
LAN/VLAN as the bridge.
