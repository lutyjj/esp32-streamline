"""Contract tests for merged-flash-image padding."""

import unittest

from streamline_tools.device.flash_image import pad_flash_image

MEBIBYTE = 1024 * 1024


def merged_image(size_field: int, length: int) -> bytes:
    """A minimal merged flash image: bootloader magic and flash-size header at 0x1000."""
    image = bytearray(b"\x00" * length)
    image[0x1000] = 0xE9
    image[0x1003] = size_field << 4
    return bytes(image)


class PadFlashImageTest(unittest.TestCase):
    def test_pads_to_the_declared_flash_size_with_erased_bytes(self) -> None:
        length = 2 * MEBIBYTE - 1  # smaller than 2 MiB, yet the header declares 4 MiB
        padded = pad_flash_image(merged_image(0x2, length))
        self.assertEqual(len(padded), 4 * MEBIBYTE)
        self.assertEqual(padded[length:], b"\xff" * (4 * MEBIBYTE - length))

    def test_image_at_exactly_its_declared_size_is_unchanged(self) -> None:
        image = merged_image(0x1, 2 * MEBIBYTE)
        self.assertEqual(pad_flash_image(image), image)

    def test_image_larger_than_its_declared_size_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pad_flash_image(merged_image(0x1, 2 * MEBIBYTE + 1))

    def test_missing_bootloader_magic_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pad_flash_image(b"\x00" * MEBIBYTE)

    def test_unsupported_declared_size_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            pad_flash_image(merged_image(0x0, MEBIBYTE))  # 1 MiB flash: no QEMU model


if __name__ == "__main__":
    unittest.main()
