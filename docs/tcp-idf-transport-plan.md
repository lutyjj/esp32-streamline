# TCP Transport Design Record

The firmware sends raw PCM over one persistent TCP connection (Rust `std::net`,
lwIP-backed). The bridge continues to receive `ELI1` framed packets on port 39000.

## Runtime contract

- capture: I2S RX on core 1, FreeRTOS priority 3
- transport: TCP sender on core 1, FreeRTOS priority 2
- queue: 32 fixed-capacity packets; on pressure, discard the oldest packet
- packet: 24-byte header plus up to 1,024 PCM bytes, coalesced into one write
- connect: `TcpStream::connect_timeout` with a 250 ms deadline
- send: `TCP_NODELAY` and a 250 ms write timeout via `std::net`

This separation leaves the ESP-IDF lwIP tcpip task on core 0 and prevents a
network stall from blocking I2S capture. Capture uses the safe `esp-idf-hal` I2S
driver and transport uses `std::net`, so neither the capture nor the network path
carries any unsafe FFI.

## Hardware smoke-test criteria

For a ten-minute local run, expect zero steady-state queue drops and network
errors, a bridge with no underruns after startup, and no recurring heap decline.
