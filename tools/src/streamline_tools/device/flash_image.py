"""Prepare merged flash images (`streamline-*-full.bin`) for QEMU.

The ESP32 bootloader sits at 0x1000 in a merged image; its header declares
the flash size the partition table was laid out for, and QEMU rejects every
size but the supported set. Padding to anything smaller than the declared
size boots the bootloader but fails the app's flash-chip probe.
"""

_BOOTLOADER_OFFSET = 0x1000
_IMAGE_MAGIC = 0xE9
_FLASH_SIZE_MEGABYTES = {0x1: 2, 0x2: 4, 0x3: 8, 0x4: 16}
_ERASED_FLASH_BYTE = b"\xff"


def pad_flash_image(image: bytes) -> bytes:
    """Pad a merged flash image with erased-flash bytes to its declared flash size."""
    header = image[_BOOTLOADER_OFFSET : _BOOTLOADER_OFFSET + 4]
    if len(header) < 4 or header[0] != _IMAGE_MAGIC:
        raise ValueError("not a merged flash image: no bootloader at offset 0x1000 (need streamline-*-full.bin)")
    size_field = header[3] >> 4
    megabytes = _FLASH_SIZE_MEGABYTES.get(size_field)
    if megabytes is None:
        raise ValueError(f"image declares flash size field {size_field:#x}, which QEMU cannot emulate")
    size = megabytes * 1024 * 1024
    if len(image) > size:
        raise ValueError(f"flash image is {len(image)} bytes but declares a {megabytes} MiB flash")
    return image + _ERASED_FLASH_BYTE * (size - len(image))
