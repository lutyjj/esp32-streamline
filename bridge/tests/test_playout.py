from __future__ import annotations

import struct
import threading
import unittest
from itertools import pairwise
from typing import cast

from streamline_bridge.fanout import ClientFanout
from streamline_bridge.playout import MAX_UINT32, PlayoutBuffer, PlayoutWorker
from streamline_bridge.protocol import DEFAULT_FORMAT


class FakeClock:
    def __init__(self) -> None:
        self.current = 100.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.current

    def monotonic(self) -> float:
        return self.current

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.current += seconds


def payload(sample: int) -> bytes:
    return struct.pack("<h", sample) * (DEFAULT_FORMAT.payload_bytes // 2)


class PlayoutBufferTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()

    def make_buffer(self, buffered_packets: int = 1, outage_packets: int = 2) -> PlayoutBuffer:
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        return PlayoutBuffer(
            playout_buffer_seconds=interval * buffered_packets,
            max_playout_buffer_seconds=interval * buffered_packets,
            max_repeat_conceal_packets=1,
            max_outage_silence_seconds=interval * outage_packets,
            clock=self.clock,
        )

    def test_wrap_reorder_duplicate_and_late_packets_have_deterministic_policy(self) -> None:
        buffer = self.make_buffer(buffered_packets=3)
        maximum = payload(1000)
        zero = payload(2000)
        reordered = payload(3000)
        buffer.ingest(MAX_UINT32, maximum)
        buffer.ingest(1, reordered)
        buffer.ingest(0, zero)
        buffer.ingest(0, zero)
        self.assertEqual(buffer.next_chunk(), maximum)
        self.assertEqual(buffer.next_chunk(), zero)
        buffer.ingest(MAX_UINT32, maximum)
        snapshot = buffer.snapshot()
        self.assertEqual(buffer.next_chunk(), reordered)
        self.assertEqual(snapshot["reordered"], 1)
        self.assertEqual(snapshot["duplicate"], 1)
        self.assertEqual(snapshot["late"], 1)

    def test_short_loss_repeats_then_silences(self) -> None:
        buffer = self.make_buffer()
        source = payload(10_000)
        buffer.ingest(4, source)
        self.assertEqual(buffer.next_chunk(), source)
        self.assertEqual(buffer.next_chunk(), payload(5000))
        self.assertEqual(buffer.next_chunk(), bytes(DEFAULT_FORMAT.payload_bytes))
        self.assertEqual(buffer.snapshot()["missing_packets"], 2)

    def test_explicit_silence_keeps_playout_ready_without_loss_or_underruns(self) -> None:
        buffer = self.make_buffer()
        buffer.ingest(0, payload(1000))
        buffer.next_chunk()
        for seq in range(1, 501):
            buffer.ingest(seq, b"")
            self.assertEqual(buffer.next_chunk(), bytes(DEFAULT_FORMAT.payload_bytes))
            self.clock.current += buffer.packet_interval
        snapshot = buffer.snapshot()
        self.assertEqual(snapshot["silence_packets"], 500)
        self.assertEqual(snapshot["missing_packets"], 0)
        self.assertEqual(snapshot["underruns"], 0)
        quality = cast("dict[str, int | float]", snapshot["quality"])
        self.assertEqual(quality["silence_packets"], 500)
        self.assertEqual(quality["audio_packets"], 1)
        self.assertEqual(quality["missing_packets"], 0)
        self.assertIsNotNone(snapshot["buffer_ready_at"])
        # An absent record remains unknown loss, even if its neighbours are silence.
        buffer.next_chunk()
        self.assertEqual(buffer.snapshot()["missing_packets"], 1)
        buffer.ingest(502, payload(2000))
        self.assertEqual(buffer.next_chunk(), payload(2000))

    def test_duplicate_and_late_silence_do_not_inflate_intentional_playout(self) -> None:
        buffer = self.make_buffer()
        buffer.ingest(MAX_UINT32, b"")
        buffer.ingest(MAX_UINT32, b"")
        buffer.next_chunk()
        buffer.ingest(MAX_UINT32, b"")
        buffer.ingest(0, payload(3000))
        self.assertEqual(buffer.next_chunk(), payload(3000))
        snapshot = buffer.snapshot()
        self.assertEqual(snapshot["silence_packets"], 1)
        self.assertEqual(snapshot["duplicate"], 1)
        self.assertEqual(snapshot["late"], 1)

    def test_long_loss_rebuffers_then_new_packet_starts_a_new_run(self) -> None:
        buffer = self.make_buffer(outage_packets=1)
        buffer.ingest(4, payload(10_000))
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNotNone(buffer.next_chunk())
        for _ in range(100):
            self.assertEqual(buffer.next_chunk(), bytes(DEFAULT_FORMAT.payload_bytes))
        self.assertEqual(buffer.snapshot()["underruns"], 1)
        self.assertEqual(
            buffer.snapshot()["missing_packets"], 2, "waiting for resumed audio is not further packet loss"
        )
        buffer.ingest(20, payload(2000))
        self.assertEqual(buffer.next_chunk(), payload(2000))

    def test_session_reset_discards_old_sequence_state(self) -> None:
        buffer = self.make_buffer()
        buffer.ingest(50, payload(10))
        buffer.reset_source_session()
        buffer.ingest(0, payload(20))
        self.assertEqual(buffer.next_chunk(), payload(20))

    def test_sustained_flooding_stops_at_the_admission_ceiling(self) -> None:
        buffer = self.make_buffer(buffered_packets=2)
        ceiling = buffer.stats.max_buffered_packets
        for seq in range(ceiling):
            self.assertTrue(buffer.ingest(seq, payload(seq)), f"packet {seq} is within the ceiling")
        self.assertFalse(buffer.ingest(ceiling, payload(ceiling)), "the packet past the ceiling is refused")
        snapshot = buffer.snapshot()
        self.assertEqual(snapshot["buffered_packets"], ceiling)
        self.assertEqual(snapshot["overflows"], 1)
        # Draining one packet reopens exactly one admission slot.
        self.assertIsNotNone(buffer.next_chunk())
        self.assertTrue(buffer.ingest(ceiling, payload(ceiling)))
        self.assertFalse(buffer.ingest(ceiling + 1, payload(ceiling + 1)))

    def test_rebuffering_clears_stored_packets_with_the_sequence_state(self) -> None:
        buffer = self.make_buffer(outage_packets=1)
        buffer.ingest(4, payload(10_000))
        buffer.ingest(90, payload(1))  # far ahead: reachable only by playing the whole gap
        for _ in range(3):
            buffer.next_chunk()
        self.assertEqual(buffer.snapshot()["underruns"], 1)
        self.assertEqual(buffer.snapshot()["buffered_packets"], 0)

    def test_silence_continues_until_the_resumed_buffer_reaches_its_target(self) -> None:
        buffer = self.make_buffer(buffered_packets=2, outage_packets=1)
        for seq in (0, 1):
            buffer.ingest(seq, payload(1000))
        for _ in range(4):
            buffer.next_chunk()
        buffer.ingest(100, payload(2000))
        self.assertEqual(buffer.next_chunk(), bytes(DEFAULT_FORMAT.payload_bytes))
        self.assertEqual(buffer.snapshot()["playout_seq"], 100)
        buffer.ingest(101, payload(3000))
        self.assertEqual(buffer.next_chunk(), payload(2000))
        self.assertEqual(buffer.next_chunk(), payload(3000))

    def test_a_closed_buffer_refuses_packets_and_unblocks_its_worker(self) -> None:
        buffer = self.make_buffer()
        buffer.ingest(1, payload(1))
        buffer.close()
        self.assertTrue(buffer.closed)
        self.assertFalse(buffer.ingest(2, payload(2)))
        self.assertIsNone(buffer.next_chunk())
        buffer.wait_until_ready()  # returns instead of blocking forever

    def test_adaptation_protects_pcm_after_learning_a_repeated_tcp_stall_during_silence(self) -> None:
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        adaptive = PlayoutBuffer(interval * 4, 0, 5.0, clock=self.clock, max_playout_buffer_seconds=interval * 80)
        fixed = self.make_buffer(buffered_packets=4, outage_packets=1000)
        played: list[bytes] = []
        pending: list[int] = []
        before: list[int] = []
        for tick in range(700):
            self.clock.current = 100.0 + tick * interval
            pending.append(tick)
            if not (100 <= tick < 120 or 300 <= tick < 320):
                for seq in pending:
                    data = b"" if seq < 200 else payload(seq)
                    self.assertTrue(adaptive.ingest(seq, data))
                    self.assertTrue(fixed.ingest(seq, data))
                pending.clear()
            if tick == 250:
                before = [adaptive.stats.missing_packets, fixed.stats.missing_packets]
            chunk = adaptive.next_chunk()
            fixed.next_chunk()
            if chunk and any(chunk):
                played.append(chunk)
        self.assertEqual(adaptive.stats.missing_packets - before[0], 0)
        self.assertGreater(fixed.stats.missing_packets - before[1], 0)
        self.assertGreater(adaptive.stats.buffer_expansion_packets, 0)
        self.assertEqual(played, [payload(seq) for seq in range(200, 200 + len(played))])
        self.assertGreater(len(played), 400)

    def test_lower_target_removes_only_explicit_silence_and_never_pcm(self) -> None:
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        buffer = PlayoutBuffer(interval * 4, 0, 5.0, clock=self.clock, max_playout_buffer_seconds=interval * 40)
        buffer.ingest(0, b"")
        self.clock.current += 20 * interval
        buffer.ingest(1, b"")
        for seq in range(2, 35):
            self.clock.current += interval
            buffer.ingest(seq, b"")
        buffer.ingest(35, payload(101))
        buffer.ingest(36, b"")
        buffer.ingest(37, payload(102))
        buffer.next_chunk()
        applied = buffer.stats.applied_buffer_packets
        self.assertGreater(applied, 4)
        # Advance capture and arrival together; a clean minute permits one decrease.
        self.clock.current += 61.0
        buffer.ingest(38 + round(61 / interval), payload(500))
        buffer.next_chunk()
        self.assertEqual(buffer.stats.buffer_reduction_packets, 1)
        self.assertEqual(buffer.stats.applied_buffer_packets, applied - 1)
        self.assertEqual(buffer.stats.missing_packets, 0)
        played = [buffer.next_chunk() for _ in range(38)]
        self.assertEqual([chunk for chunk in played if chunk and any(chunk)], [payload(101), payload(102)])

    def test_active_pcm_defers_growth_and_reconnect_uses_the_learned_target(self) -> None:
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        buffer = PlayoutBuffer(interval, 0, 5.0, clock=self.clock, max_playout_buffer_seconds=interval * 40)
        buffer.ingest(MAX_UINT32, payload(1))
        self.assertEqual(buffer.next_chunk(), payload(1))
        self.clock.current += 20 * interval
        buffer.ingest(0, payload(2))
        self.assertEqual(buffer.next_chunk(), payload(2))
        self.assertGreater(cast("int", buffer.snapshot()["playout_buffer_packets"]), 1)
        self.assertEqual(buffer.stats.applied_buffer_packets, 1)
        self.assertEqual(buffer.stats.buffer_expansion_packets, 0)
        buffer.reset_source_session()
        buffer.ingest(0, payload(3))
        self.assertEqual(buffer.next_chunk(), bytes(DEFAULT_FORMAT.payload_bytes))
        self.assertIsNone(buffer.stats.buffer_ready_at)


class PlayoutWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        self.buffer = PlayoutBuffer(
            playout_buffer_seconds=interval,
            max_playout_buffer_seconds=interval,
            max_repeat_conceal_packets=1,
            max_outage_silence_seconds=interval * 2,
            clock=self.clock,
        )
        self.published: list[bytes] = []
        self.thread = threading.Thread(
            target=PlayoutWorker(self.buffer, self.published.append, self.clock).run, daemon=True
        )

    def close_and_join(self) -> None:
        self.buffer.close()
        self.thread.join(timeout=5.0)
        self.assertFalse(self.thread.is_alive(), "the worker exits after close")

    def test_close_ends_an_idle_worker_waiting_for_its_buffer(self) -> None:
        self.thread.start()
        self.close_and_join()

    def test_close_ends_a_playing_worker_and_no_chunk_follows(self) -> None:
        self.thread.start()
        self.buffer.ingest(0, payload(1))
        self.close_and_join()
        seen = len(self.published)
        self.assertFalse(self.buffer.ingest(1, payload(2)))
        self.assertEqual(len(self.published), seen, "a closed pipeline publishes no later chunks")

    def test_rebuffering_keeps_output_paced_and_resumes_at_the_new_sequence(self) -> None:
        times: list[float] = []

        def publish(chunk: bytes) -> None:
            self.published.append(chunk)
            times.append(self.clock.monotonic())
            if len(self.published) == 8:
                self.buffer.ingest(10_000, payload(2000))
            if len(self.published) == 9:
                self.buffer.close()

        self.buffer.ingest(0, payload(1000))
        worker = threading.Thread(target=PlayoutWorker(self.buffer, publish, self.clock).run, daemon=True)
        worker.start()
        worker.join(timeout=1.0)
        completed = not worker.is_alive()
        self.buffer.close()
        worker.join(timeout=1.0)

        self.assertTrue(completed, "output must continue beyond the outage-silence budget")
        self.assertEqual(self.published[4:8], [bytes(DEFAULT_FORMAT.payload_bytes)] * 4)
        self.assertEqual(self.published[8], payload(2000))
        for previous, current in pairwise(times):
            self.assertAlmostEqual(current - previous, self.buffer.packet_interval)
        self.assertEqual(self.buffer.snapshot()["played_frames"], 9 * DEFAULT_FORMAT.frames_per_packet)


class ClientFanoutTests(unittest.TestCase):
    def test_overflow_evicts_a_slow_client(self) -> None:
        fanout = ClientFanout(1)
        stream = fanout.register("192.0.2.10", "/streamline.wav")
        fanout.publish(b"first")
        fanout.publish(b"second")
        snapshot = fanout.snapshot()
        self.assertEqual(snapshot["clients"], 0)
        self.assertEqual(snapshot["slow_clients"], 1)
        self.assertEqual(snapshot["client_queue_drops"], 1)
        self.assertIsNone(stream.queue.get_nowait())

    def test_close_ends_streams_without_counting_slow_clients(self) -> None:
        fanout = ClientFanout(2)
        stream = fanout.register("192.0.2.10", "/streamline.wav")
        fanout.publish(b"chunk")
        fanout.close()
        snapshot = fanout.snapshot()
        self.assertEqual(snapshot["clients"], 0)
        self.assertEqual(snapshot["slow_clients"], 0)
        self.assertIsNone(stream.queue.get_nowait(), "the drained stream ends with the close sentinel")
