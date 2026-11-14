"""Library for driving one StreamLine device, real or emulated.

Each module owns one concern: `flash_image` prepares merged images for QEMU,
`capture` reads serial output to a boot marker, `boot_log` judges a captured
boot transcript, `api` talks to the device HTTP surface, `emulator` ends a
wait on an emulated device once QEMU exits, and `checks` is the shared result
model. `capture`, `boot_log` and `checks` use only the standard library.
"""
