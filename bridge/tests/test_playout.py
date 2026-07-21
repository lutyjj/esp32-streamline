from __future__ import annotations

import struct
import threading
import unittest

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
        self.assertEqual(buffer.snapshot()["concealed"], 2)

    def test_long_loss_rebuffers_then_new_packet_starts_a_new_run(self) -> None:
        buffer = self.make_buffer(outage_packets=1)
        buffer.ingest(4, payload(10_000))
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNotNone(buffer.next_chunk())
        self.assertIsNone(buffer.next_chunk())
        self.assertEqual(buffer.snapshot()["underruns"], 1)
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
        while buffer.next_chunk() is not None:
            pass
        self.assertEqual(buffer.snapshot()["underruns"], 1)
        self.assertEqual(buffer.snapshot()["buffered_packets"], 0)

    def test_a_closed_buffer_refuses_packets_and_unblocks_its_worker(self) -> None:
        buffer = self.make_buffer()
        buffer.ingest(1, payload(1))
        buffer.close()
        self.assertTrue(buffer.closed)
        self.assertFalse(buffer.ingest(2, payload(2)))
        self.assertIsNone(buffer.next_chunk())
        buffer.wait_until_ready()  # returns instead of blocking forever


class PlayoutWorkerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        interval = DEFAULT_FORMAT.frames_per_packet / DEFAULT_FORMAT.rate
        self.buffer = PlayoutBuffer(
            playout_buffer_seconds=interval,
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
