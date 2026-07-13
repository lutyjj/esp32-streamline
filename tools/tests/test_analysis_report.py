"""Behavioral tests for typed-result formatting.

The CLI renders typed results; formatting must read those fields, not recompute.
"""

import unittest

from streamline_tools.analysis.measure import BandDelta, ChannelStats, MidSideBalance
from streamline_tools.analysis.report import (
    format_basic_stats,
    format_frequency_delta,
    format_mid_side,
    format_transform_score,
)
from streamline_tools.analysis.transform import TransformScore


class FormattingTest(unittest.TestCase):
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
