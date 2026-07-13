"""Library for driving one StreamLine device, real or emulated.

Each module owns one concern: `flash_image` prepares merged images for QEMU,
`capture` reads serial output to a boot marker, `boot_log` judges a captured
boot transcript, `api` talks to the device HTTP surface, and `checks` is the
shared result model. Everything is stdlib-only so the host `python3` can run
the serial flows outside a container.
"""
