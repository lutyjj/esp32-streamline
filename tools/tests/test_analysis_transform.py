"""Behavioral tests for channel-transform scoring and selection."""

import unittest

import numpy as np
from audio_fixtures import Float32Array, modulated_noise

from streamline_tools.analysis.transform import (
    TransformScore,
    best_transform,
    score_transform,
    score_transforms,
    stereo_corr,
)

GAIN_TOL = 0.02  # linear gain recovery
UNITY_CORR_TOL = 1e-3  # how close a perfect match sits to corr=1.0
ZERO_NRMSE_TOL = 1e-3  # residual error of a perfect match
DECORRELATED_TOL = 0.05  # |corr| between independent channels


class GainRecoveryTest(unittest.TestCase):
    def test_recovers_per_channel_gain_and_reports_a_clean_fit(self) -> None:
        reference = modulated_noise(seed=10, seconds=1.0)
        candidate = np.column_stack([reference[:, 0] * 0.5, reference[:, 1] * 0.25]).astype(np.float32)
        nrmse, corr, gains = score_transform(reference, candidate)
        self.assertAlmostEqual(gains[0], 2.0, delta=GAIN_TOL)
        self.assertAlmostEqual(gains[1], 4.0, delta=GAIN_TOL)
        self.assertLess(nrmse, ZERO_NRMSE_TOL)
        self.assertGreater(corr, 1.0 - UNITY_CORR_TOL)

    def test_clamps_negative_gain_so_an_inverted_candidate_scores_poorly(self) -> None:
        reference = modulated_noise(seed=11, seconds=1.0)
        inverted = (-reference).astype(np.float32)
        nrmse, _corr, gains = score_transform(reference, inverted)
        self.assertEqual(gains[0], 0.0)
        self.assertEqual(gains[1], 0.0)
        self.assertGreater(nrmse, 0.9)


class TransformSelectionTest(unittest.TestCase):
    def _best_name(self, reference: Float32Array, capture: Float32Array) -> str:
        scores = score_transforms(reference, capture)
        self.assertTrue(all(isinstance(score, TransformScore) for score in scores))
        return best_transform(scores).name

    def test_identity_capture_prefers_normal(self) -> None:
        reference = modulated_noise(seed=20, seconds=1.0)
        self.assertEqual(self._best_name(reference, reference.copy()), "normal")

    def test_swapped_channels_are_detected(self) -> None:
        reference = modulated_noise(seed=21, seconds=1.0)
        swapped = np.column_stack([reference[:, 1], reference[:, 0]]).astype(np.float32)
        self.assertEqual(self._best_name(reference, swapped), "swap_lr")

    def test_polarity_inversion_is_detected(self) -> None:
        reference = modulated_noise(seed=22, seconds=1.0)
        inverted = (-reference).astype(np.float32)
        self.assertEqual(self._best_name(reference, inverted), "invert_both")


class StereoCorrTest(unittest.TestCase):
    def test_identical_signals_correlate_at_one(self) -> None:
        reference = modulated_noise(seed=30, seconds=0.5)
        self.assertAlmostEqual(stereo_corr(reference, reference.copy()), 1.0, delta=UNITY_CORR_TOL)

    def test_inverted_signals_correlate_at_minus_one(self) -> None:
        reference = modulated_noise(seed=31, seconds=0.5)
        self.assertAlmostEqual(stereo_corr(reference, (-reference).astype(np.float32)), -1.0, delta=UNITY_CORR_TOL)

    def test_independent_signals_are_uncorrelated(self) -> None:
        a = modulated_noise(seed=32, seconds=0.5)
        b = modulated_noise(seed=33, seconds=0.5)
        self.assertLess(abs(stereo_corr(a, b)), DECORRELATED_TOL)


if __name__ == "__main__":
    unittest.main()
