"""Behavioral tests for the capture-vs-reference analyzer.

Every fixture is synthetic and seeded, so the numeric contracts below are
deterministic and independent of ffmpeg. Tolerances are named, not magic.
"""

import tempfile
import unittest
from pathlib import Path

import numpy as np
import numpy.typing as npt

from streamline_tools.analyze_capture import (
    BLOCK,
    CHANNELS,
    CLIP_THRESHOLD,
    SAMPLE_RATE,
    BandDelta,
    ChannelStats,
    MidSideBalance,
    TransformScore,
    align,
    basic_stats,
    best_transform,
    find_lag,
    fine_tune_lag,
    format_basic_stats,
    format_frequency_delta,
    format_mid_side,
    format_transform_score,
    frequency_delta,
    mid_side,
    read_raw_s16le,
    rms_envelope,
    score_transform,
    score_transforms,
    stereo_corr,
)

Float32Array = npt.NDArray[np.float32]

# Named tolerances shared across cases.
GAIN_TOL = 0.02  # linear gain recovery
UNITY_CORR_TOL = 1e-3  # how close a perfect match sits to corr=1.0
ZERO_NRMSE_TOL = 1e-3  # residual error of a perfect match
DECORRELATED_TOL = 0.05  # |corr| between independent channels
FINE_LAG_TOL_FRAMES = 8  # sample-accurate alignment slack
LOW_BAND_BOOST_DB = 6.0  # minimum lift a low-frequency injection must show


def modulated_noise(seed: int, seconds: float) -> Float32Array:
    """Independent-per-channel noise with a slow amplitude envelope.

    The envelope gives each 1024-sample block a distinctive RMS, so the
    envelope cross-correlation used for alignment has a sharp, unambiguous peak.
    """
    rng = np.random.default_rng(seed)
    frames = int(seconds * SAMPLE_RATE)
    t = np.arange(frames) / SAMPLE_RATE
    envelope = 0.5 + 0.5 * np.abs(np.sin(2.0 * np.pi * 1.5 * t))
    noise = rng.standard_normal((frames, CHANNELS))
    signal = noise * envelope[:, None] * 0.3
    return signal.astype(np.float32)


def delay(signal: Float32Array, frames: int) -> Float32Array:
    """Prepend `frames` of silence, modeling a capture that starts late."""
    pad = np.zeros((frames, CHANNELS), dtype=np.float32)
    return np.concatenate([pad, signal], axis=0)


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
        nrmse, corr, gains = score_transform(reference, inverted)
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


class ShortInputTest(unittest.TestCase):
    def test_rms_envelope_rejects_a_sub_block_signal(self) -> None:
        audio = np.zeros((BLOCK - 1, CHANNELS), dtype=np.float32)
        with self.assertRaises(SystemExit):
            rms_envelope(audio)

    def test_frequency_delta_rejects_a_sub_fft_signal(self) -> None:
        short = modulated_noise(seed=60, seconds=0.05)  # fewer than one FFT window
        with self.assertRaises(SystemExit):
            frequency_delta(short, short.copy())


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


class FormattingTest(unittest.TestCase):
    """The CLI renders typed results; formatting must read those fields, not recompute."""

    def test_basic_stats_line_reads_from_the_dataclass(self) -> None:
        stats = ChannelStats(peak_dbfs=(-1.0, -2.0), rms_dbfs=(-10.0, -11.0), dc_offset=(0.001, -0.002), clips=7)
        line = format_basic_stats("capture", stats)
        self.assertIn("capture", line)
        self.assertIn("clips=7", line)
        self.assertIn("peak L/R= -1.00/ -2.00", line)

    def test_mid_side_line_reads_from_the_dataclass(self) -> None:
        line = format_mid_side("reference", MidSideBalance(mid_rms_dbfs=-12.5, side_minus_mid_db=-3.25))
        self.assertIn("mid_rms= -12.50", line)
        self.assertIn("side-mid= -3.25", line)

    def test_transform_score_line_reads_from_the_dataclass(self) -> None:
        line = format_transform_score(TransformScore(name="swap_lr", nrmse=0.123, corr=0.987, gains=(1.5, 0.5)))
        self.assertIn("swap_lr", line)
        self.assertIn("nrmse= 0.123", line)
        self.assertIn("corr= 0.9870", line)

    def test_frequency_delta_line_reads_from_the_dataclass(self) -> None:
        line = format_frequency_delta(BandDelta(lo=20.0, hi=60.0, capture_minus_reference_db=4.2))
        self.assertIn("20-60", line)
        self.assertIn("+4.20 dB", line)


if __name__ == "__main__":
    unittest.main()
