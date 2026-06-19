# Codec Scan Firmware

Purpose: identify the audio codec on the ESP32 Audio Kit board.

This target is intentionally tiny. It should:

1. boot the ESP32
2. scan I2C on likely Audio Kit pins
3. print all responding addresses over serial

Primary pin pair:

```text
SDA GPIO33
SCL GPIO32
```

If that returns no devices, scan these alternates:

```text
SDA GPIO18 / SCL GPIO23
SDA GPIO21 / SCL GPIO22
```

Expected useful hits:

```text
0x1A  likely AC101
0x10  likely ES8388
```

Use `/dev/cu.usbserial-0001` for upload/monitor on this Mac.

