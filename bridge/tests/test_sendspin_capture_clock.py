from __future__ import annotations

import unittest

from streamline_bridge.sendspin.capture_clock import CaptureClock


def nominal_us(packets: int) -> int:
    return packets * 256 * 1_000_000 // 48_000


class CaptureClockTests(unittest.TestCase):
    def test_burst_after_a_stall_keeps_its_capture_spacing(self) -> None:
        clock = CaptureClock()
        start = 1_000_000
        for seq in range(10):
            clock.timestamp(seq, start + nominal_us(seq) + 3_000)
        stall_end = start + nominal_us(60) + 3_000
        for seq in range(10, 60):
            capture = start + nominal_us(seq) + 3_000
            # The drift allowance may lift the estimate by 200 ppm of the stall.
            self.assertAlmostEqual(clock.timestamp(seq, stall_end + seq), capture, delta=60)

    def test_follows_the_earliest_arrival_through_jitter(self) -> None:
        clock = CaptureClock()
        jitter = [9_000, 2_000, 15_000, 4_000, 2_500, 30_000]
        stamps = [clock.timestamp(seq, nominal_us(seq) + delay) for seq, delay in enumerate(jitter)]

        self.assertAlmostEqual(stamps[-1], nominal_us(5) + 2_000, delta=10)

    def test_sequence_wrap_continues_the_timeline(self) -> None:
        clock = CaptureClock()
        last = 0xFFFF_FFFF
        clock.timestamp(last - 1, 0)
        clock.timestamp(last, nominal_us(1))

        self.assertEqual(clock.timestamp(0, nominal_us(2)), nominal_us(2))
        self.assertEqual(clock.timestamp(5, nominal_us(7)), nominal_us(7))

    def test_dropped_packets_advance_the_timeline(self) -> None:
        clock = CaptureClock()
        clock.timestamp(100, 0)

        # The drift allowance may lift the estimate by 200 ppm of the skipped audio.
        self.assertAlmostEqual(clock.timestamp(140, nominal_us(40) + 50_000), nominal_us(40), delta=50)

    def test_tracks_a_slower_device_clock_within_the_drift_allowance(self) -> None:
        clock = CaptureClock()
        drift_ppm = 100
        for seq in range(18_750):  # 100 seconds of packets
            capture = nominal_us(seq) * (1_000_000 + drift_ppm) // 1_000_000
            stamped = clock.timestamp(seq, capture)

        self.assertLessEqual(abs(capture - stamped), 2)

    def test_a_large_sequence_jump_anchors_a_new_timeline(self) -> None:
        clock = CaptureClock()
        clock.timestamp(5_000, 0)
        clock.timestamp(5_001, nominal_us(1))

        self.assertEqual(clock.timestamp(3, 90_000_000), 90_000_000)
        self.assertEqual(clock.timestamp(4, 90_000_000 + nominal_us(1)), 90_000_000 + nominal_us(1))

    def test_reset_anchors_the_next_packet_on_arrival(self) -> None:
        clock = CaptureClock()
        clock.timestamp(1, 0)
        clock.reset()

        self.assertEqual(clock.timestamp(2, 7_777_777), 7_777_777)


if __name__ == "__main__":
    unittest.main()
