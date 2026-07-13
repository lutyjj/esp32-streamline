"""Behavioral tests for level and spectral statistics."""

import unittest

import numpy as np
from audio_fixtures import modulated_noise

from streamline_tools.analysis.measure import (
    CLIP_THRESHOLD,
    BandDelta,
    ChannelStats,
    MidSideBalance,
    basic_stats,
    frequency_delta,
    mid_side,
)
from streamline_tools.analysis.signal import CHANNELS, SAMPLE_RATE

LOW_BAND_BOOST_DB = 6.0  # minimum lift a low-frequency injection must show


class BasicStatsTest(unittest.TestCase):
    def test_counts_full_scale_clips_on_both_channels(self) -> None:
        audio = np.zeros((100, CHANNELS), dtype=np.float32)
        audio[0, 0] = 1.0
        audio[1, 0] = -1.0
        audio[2, 1] = CLIP_THRESHOLD  # exactly at the threshold clips
        audio[3, 1] = CLIP_THRESHOLD - 1e-3  # just under does not
        stats = basic_stats(audio)
        self.assertIsInstance(stats, ChannelStats)
        self.assertEqual(stats.clips, 3)

    def test_reports_per_channel_dc_offset(self) -> None:
        rng = np.random.default_rng(1)
        audio = (rng.standard_normal((SAMPLE_RATE, CHANNELS)) * 0.1).astype(np.float32)
        audio[:, 0] += 0.25
        audio[:, 1] -= 0.10
        stats = basic_stats(audio)
        self.assertAlmostEqual(stats.dc_offset[0], 0.25, delta=0.01)
        self.assertAlmostEqual(stats.dc_offset[1], -0.10, delta=0.01)


class MidSideTest(unittest.TestCase):
    def test_mono_content_pushes_side_far_below_mid(self) -> None:
        rng = np.random.default_rng(40)
        mono = (rng.standard_normal(SAMPLE_RATE) * 0.3).astype(np.float32)
        audio = np.column_stack([mono, mono])
        balance = mid_side(audio)
        self.assertIsInstance(balance, MidSideBalance)
        self.assertLess(balance.side_minus_mid_db, -100.0)

    def test_out_of_phase_content_pushes_side_above_mid(self) -> None:
        rng = np.random.default_rng(41)
        mono = (rng.standard_normal(SAMPLE_RATE) * 0.3).astype(np.float32)
        audio = np.column_stack([mono, -mono])
        balance = mid_side(audio)
        self.assertGreater(balance.side_minus_mid_db, 100.0)


class FrequencyDeltaTest(unittest.TestCase):
    def test_low_frequency_injection_lifts_the_low_band(self) -> None:
        reference = modulated_noise(seed=70, seconds=3.0)
        frames = reference.shape[0]
        t = np.arange(frames) / SAMPLE_RATE
        bass = (0.4 * np.sin(2.0 * np.pi * 40.0 * t)).astype(np.float32)
        capture = (reference + bass[:, None]).astype(np.float32)

        deltas = frequency_delta(reference, capture)
        self.assertTrue(all(isinstance(delta, BandDelta) for delta in deltas))
        by_band = {(delta.lo, delta.hi): delta.capture_minus_reference_db for delta in deltas}

        self.assertGreater(by_band[(20.0, 60.0)], LOW_BAND_BOOST_DB)
        # 250-1000 Hz is the normalization band, so its delta is zero by construction.
        self.assertAlmostEqual(by_band[(250.0, 1000.0)], 0.0, delta=1e-6)

    def test_rejects_a_sub_fft_signal(self) -> None:
        short = modulated_noise(seed=71, seconds=0.05)  # fewer than one FFT window
        with self.assertRaises(SystemExit):
            frequency_delta(short, short.copy())


if __name__ == "__main__":
    unittest.main()
