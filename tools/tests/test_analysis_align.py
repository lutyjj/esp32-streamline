"""Behavioral tests for capture-to-reference alignment."""

import unittest

import numpy as np
from audio_fixtures import delay, modulated_noise

from streamline_tools.analysis.align import BLOCK, align, find_lag, fine_tune_lag, rms_envelope
from streamline_tools.analysis.signal import CHANNELS, SAMPLE_RATE
from streamline_tools.analysis.transform import stereo_corr

UNITY_CORR_TOL = 1e-3  # how close a perfect match sits to corr=1.0
FINE_LAG_TOL_FRAMES = 8  # sample-accurate alignment slack


class AlignmentTest(unittest.TestCase):
    def test_find_lag_recovers_a_block_aligned_delay(self) -> None:
        reference = modulated_noise(seed=50, seconds=6.0)
        offset = 5 * BLOCK
        capture = delay(reference, offset)
        self.assertAlmostEqual(find_lag(reference, capture), offset, delta=BLOCK)

    def test_fine_tune_recovers_a_sub_block_delay(self) -> None:
        reference = modulated_noise(seed=51, seconds=6.0)
        offset = 5 * BLOCK + 137  # not a block multiple
        capture = delay(reference, offset)
        coarse = find_lag(reference, capture)
        refined = fine_tune_lag(reference, capture, coarse)
        self.assertAlmostEqual(refined, offset, delta=FINE_LAG_TOL_FRAMES)

    def test_align_produces_matched_windows_and_honors_max_seconds(self) -> None:
        reference = modulated_noise(seed=52, seconds=8.0)
        capture = delay(reference, 3 * BLOCK)
        aligned = align(reference, capture, skip_seconds=0.5, max_seconds=5.0)
        self.assertEqual(aligned.reference.shape, aligned.capture.shape)
        self.assertEqual(aligned.reference.shape[0], int(5.0 * SAMPLE_RATE))
        self.assertGreater(stereo_corr(aligned.reference, aligned.capture), 1.0 - UNITY_CORR_TOL)

    def test_align_rejects_too_little_overlap(self) -> None:
        reference = modulated_noise(seed=53, seconds=2.0)  # under the 5s minimum
        with self.assertRaises(SystemExit):
            align(reference, reference.copy(), skip_seconds=0.0, max_seconds=120.0, lag=0)

    def test_rms_envelope_rejects_a_sub_block_signal(self) -> None:
        audio = np.zeros((BLOCK - 1, CHANNELS), dtype=np.float32)
        with self.assertRaises(SystemExit):
            rms_envelope(audio)


if __name__ == "__main__":
    unittest.main()
