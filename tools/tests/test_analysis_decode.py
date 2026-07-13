"""Behavioral tests for decoding audio files into stereo float frames."""

import tempfile
import unittest
from pathlib import Path

import numpy as np

from streamline_tools.analysis.decode import read_raw_s16le
from streamline_tools.analysis.signal import CHANNELS


class RawPcmDecodeTest(unittest.TestCase):
    def test_decodes_int16_to_normalized_floats(self) -> None:
        samples = np.array([0, 16384, -32768, 32767], dtype="<i2")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "capture.raw"
            samples.tofile(path)
            decoded = read_raw_s16le(path)
        self.assertEqual(decoded.shape, (2, CHANNELS))
        expected = np.array([[0.0, 0.5], [-1.0, 32767 / 32768.0]])
        np.testing.assert_allclose(decoded, expected, atol=1e-6)

    def test_drops_a_trailing_partial_frame(self) -> None:
        samples = np.array([0, 16384, -32768, 32767, 100], dtype="<i2")  # odd count
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "capture.raw"
            samples.tofile(path)
            decoded = read_raw_s16le(path)
        self.assertEqual(decoded.shape, (2, CHANNELS))  # the stray sample is discarded


if __name__ == "__main__":
    unittest.main()
