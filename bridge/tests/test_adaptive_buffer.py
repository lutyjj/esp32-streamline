from __future__ import annotations

import unittest

from streamline_bridge.adaptive_buffer import AdaptiveBuffer


class AdaptiveBufferTests(unittest.TestCase):
    def test_delay_growth_is_fast_bounded_and_decay_needs_a_clean_minute(self) -> None:
        target = AdaptiveBuffer(10, 40, 0.01)
        target.observe(None, 0.0)
        target.observe(1, 0.21)
        self.assertEqual(target.target, 30)
        target.observe(20, 0.21)  # queued records arrive in one TCP burst
        target.observe(1, 0.22)
        self.assertEqual(target.target, 30)
        target.observe(5900, 59.22)
        self.assertEqual(target.target, 30)
        target.observe(100, 60.22)
        self.assertEqual(target.target, 25)
        target.observe(1, 65.0)
        self.assertEqual(target.target, 40)

    def test_capture_gaps_and_reordered_records_do_not_look_like_network_delay(self) -> None:
        target = AdaptiveBuffer(10, 40, 0.01)
        target.observe(None, 0.0)
        target.observe(100, 1.0)
        target.observe(0, 1.2)
        target.observe(-1, 1.3)
        target.observe(1, 1.01)
        self.assertEqual(target.target, 10)

    def test_losses_block_decay_and_reconnect_keeps_the_learned_target(self) -> None:
        target = AdaptiveBuffer(10, 40, 0.01)
        target.observe(None, 0.0)
        target.impair(0.5)
        target.impair(0.6)
        self.assertEqual(target.target, 15)
        target.impair(59.0)
        target.observe(6000, 60.0)
        self.assertEqual(target.target, 20)
        target.reset_arrivals()
        target.observe(None, 1000.0)
        target.observe(1, 1000.01)
        self.assertEqual(target.target, 20)

    def test_equal_bounds_keep_fixed_buffering(self) -> None:
        target = AdaptiveBuffer(10, 10, 0.01)
        target.observe(None, 0.0)
        target.observe(1, 10.0)
        target.impair(11.0)
        self.assertEqual(target.target, 10)
        with self.assertRaises(ValueError):
            AdaptiveBuffer(20, 10, 0.01)

    def test_recurring_bursts_do_not_oscillate_the_target_at_decay_boundaries(self) -> None:
        target = AdaptiveBuffer(10, 40, 0.01)
        target.observe(None, 0.0)
        for seq in range(1, 6500):
            target.observe(1, (seq // 4) * 0.04)
            self.assertEqual(target.target, 15)
