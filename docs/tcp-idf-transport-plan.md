# TCP Transport Design Record

The firmware sends raw PCM over one persistent lwIP TCP connection. The bridge
continues to receive `ELI1` framed packets on port 39000.

## Runtime contract

- capture: I2S RX on core 1, FreeRTOS priority 3
- transport: TCP sender on core 1, FreeRTOS priority 2
- queue: 32 fixed-capacity packets; on pressure, discard the oldest packet
- packet: 24-byte header plus up to 1,024 PCM bytes, coalesced into one write
- connect: non-blocking socket plus 250 ms `select` deadline
- send: `TCP_NODELAY`, 250 ms send deadline, 1,460-byte maximum write chunk

This separation leaves the ESP-IDF lwIP tcpip task on core 0 and prevents a
network stall from blocking I2S capture. The implementation uses the ESP-IDF
legacy I2S driver because it is the stable API for the original ESP32 target;
the adapter confines that unsafe FFI surface to one small module.

## Hardware smoke-test criteria

For a ten-minute local run, expect zero steady-state queue drops and network
errors, a bridge with no underruns after startup, and no recurring heap decline.
