# Audio Level Firmware

Purpose: initialize the ES8388 codec, capture stereo I2S from the line input, and
print level statistics over serial.

This is the second hardware bring-up target after `codec-scan`.

Build:

```sh
make audio-level
```

Flash:

```sh
make flash PROJECT=audio-level
```

Expected serial output:

```text
frames=... rms_l=... rms_r=... peak_l=... peak_r=...
```

Use this before adding Wi-Fi streaming. If levels stay near zero with known line-level
audio connected, rebuild with `AUDIO_INPUT_LINE=2` in `platformio.ini` to test the
other ES8388 input pair.

The first printed second can include startup transients. Use the following lines for
steady-state readings.
