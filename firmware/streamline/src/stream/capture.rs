//! Assemble bounded-age PCM packets and account capture outages on a monotonic clock.

use super::{
    effects::{Clock, Delay, PcmSource, ReadFailed},
    queue::PacketQueue,
    status::StreamStatus,
};
use crate::{
    levels::LevelStats,
    packet::AudioPacket,
    play::{PlayDetector, STOP_AFTER_PACKETS},
    protocol::{BYTES_PER_FRAME, FRAMES_PER_PACKET, PAYLOAD_BYTES, SAMPLE_RATE_HZ},
};
use std::sync::Arc;

const READ_TIMEOUT_MS: u32 = 20;
const READ_ERROR_BACKOFF_MS: u32 = 10;
const FRAMES_PER_MS: u64 = SAMPLE_RATE_HZ as u64 / 1000;
const STALL_EXPIRY_MS: u64 = STOP_AFTER_PACKETS as u64 * FRAMES_PER_PACKET as u64 / FRAMES_PER_MS;

pub struct CaptureEngine {
    detector: PlayDetector,
    pcm: [u8; PAYLOAD_BYTES],
    filled: usize,
    skip_bytes: usize,
    packet_started_ms: Option<u64>,
    last_packet_ms: Option<u64>,
    charged_frames: u64,
    lost_frame_remainder: u64,
    buffered_frames: u32,
}

impl CaptureEngine {
    pub fn new(buffered_frames: u32) -> Self {
        Self {
            detector: PlayDetector::new(),
            pcm: [0; PAYLOAD_BYTES],
            filled: 0,
            skip_bytes: 0,
            packet_started_ms: None,
            last_packet_ms: None,
            charged_frames: 0,
            lost_frame_remainder: 0,
            buffered_frames,
        }
    }

    pub fn run(
        mut self,
        mut source: impl PcmSource,
        queue: Option<Arc<PacketQueue<AudioPacket>>>,
        status: Arc<StreamStatus>,
        clock: impl Delay + Clock,
    ) -> ! {
        loop {
            self.step(&mut source, queue.as_deref(), &status, &clock);
        }
    }

    fn step(
        &mut self,
        source: &mut impl PcmSource,
        queue: Option<&PacketQueue<AudioPacket>>,
        status: &StreamStatus,
        clock: &(impl Delay + Clock),
    ) {
        if status.take_relearn() {
            self.detector = PlayDetector::new();
            status.reset_clipped();
        }
        let started = clock.monotonic_millis();
        self.last_packet_ms.get_or_insert(started);
        let offset = self.filled;
        let requested = PAYLOAD_BYTES - offset;
        let result = source.read(&mut self.pcm[offset..], READ_TIMEOUT_MS);
        let now = clock.monotonic_millis();
        self.observe_time(now, status);
        let bytes = match result {
            Ok(0) => {
                status.record_short_read();
                self.backoff(clock, status);
                return;
            }
            Ok(bytes) if bytes <= requested => bytes,
            Ok(_) | Err(ReadFailed) => {
                status.record_read_error();
                self.backoff(clock, status);
                return;
            }
        };
        if bytes < requested {
            status.record_short_read();
        }
        let skipped = self.skip_bytes.min(bytes);
        self.skip_bytes -= skipped;
        let kept = bytes - skipped;
        if kept == 0 {
            return;
        }
        self.pcm
            .copy_within(offset + skipped..offset + bytes, self.filled);
        self.filled += kept;
        self.packet_started_ms.get_or_insert(started);
        if self.filled < PAYLOAD_BYTES {
            return;
        }
        let captured_at_ms = self
            .packet_started_ms
            .take()
            .expect("packet has samples")
            .saturating_sub(u64::from(self.buffered_frames).div_ceil(FRAMES_PER_MS));
        self.filled = 0;
        self.last_packet_ms = Some(now);
        self.charged_frames = 0;
        let levels = LevelStats::analyze(&self.pcm);
        status.record_levels(levels);
        let playing = self.detector.update(levels);
        status.set_playing(playing);
        status.set_noise_floor(self.detector.noise_floor());
        let sequence = status.next_sequence();
        if !playing || !status.streaming_enabled() || status.transport_quiesce_requested() {
            return;
        }
        let Some(queue) = queue else {
            return;
        };
        let packet = AudioPacket::from_pcm(sequence, captured_at_ms, &self.pcm);
        let (dropped, depth) = queue.push_drop_oldest(packet);
        if dropped {
            status.record_queue_drop();
        }
        status.set_queue_depth(depth);
    }

    fn backoff(&mut self, clock: &(impl Delay + Clock), status: &StreamStatus) {
        clock.delay_ms(READ_ERROR_BACKOFF_MS);
        self.observe_time(clock.monotonic_millis(), status);
    }

    fn observe_time(&mut self, now: u64, status: &StreamStatus) {
        let elapsed = now.saturating_sub(*self.last_packet_ms.get_or_insert(now));
        // The driver can retain at most its configured DMA capacity during an outage.
        let lost_frames = elapsed
            .saturating_mul(FRAMES_PER_MS)
            .saturating_sub(u64::from(self.buffered_frames));
        let first_loss = lost_frames > 0 && self.charged_frames == 0;
        self.lost_frame_remainder = self
            .lost_frame_remainder
            .saturating_add(lost_frames.saturating_sub(self.charged_frames));
        self.charged_frames = lost_frames;
        let packets = self.lost_frame_remainder / u64::from(FRAMES_PER_PACKET);
        status.advance_sequence(packets as u32);
        self.lost_frame_remainder %= u64::from(FRAMES_PER_PACKET);
        let partial_expired = self.packet_started_ms.is_some_and(|start| {
            now.saturating_sub(start).saturating_mul(FRAMES_PER_MS)
                > u64::from(self.buffered_frames)
        });
        if first_loss || partial_expired {
            self.skip_bytes = (BYTES_PER_FRAME - self.filled % BYTES_PER_FRAME) % BYTES_PER_FRAME;
            self.filled = 0;
            self.packet_started_ms = None;
        }
        if elapsed >= STALL_EXPIRY_MS && self.detector.playing() {
            self.detector = PlayDetector::new();
            status.set_playing(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::VecDeque, time::Duration};

    use super::CaptureEngine;
    use crate::{
        packet::AudioPacket,
        protocol::{BYTES_PER_FRAME, PAYLOAD_BYTES},
        stream::{
            effects::{Clock, Delay, PcmSource, ReadFailed},
            queue::PacketQueue,
            status::StreamStatus,
        },
    };

    /// A sample amplitude well above the detector's start threshold.
    const LOUD: i16 = 6_000;

    /// Constant-amplitude packets: `LOUD` drives playback, `0` stays idle.
    struct ConstantSource {
        sample: i16,
    }

    impl PcmSource for ConstantSource {
        fn read(&mut self, buffer: &mut [u8], _timeout_ms: u32) -> Result<usize, ReadFailed> {
            fill(buffer, self.sample);
            Ok(buffer.len())
        }
    }

    /// Idle for the first `idle` reads, then loud forever, so the sequence gap
    /// left by the silent prefix is visible in the first enqueued packet.
    struct GatedSource {
        idle: usize,
    }

    impl PcmSource for GatedSource {
        fn read(&mut self, buffer: &mut [u8], _timeout_ms: u32) -> Result<usize, ReadFailed> {
            let sample = if self.idle > 0 {
                self.idle -= 1;
                0
            } else {
                LOUD
            };
            fill(buffer, sample);
            Ok(buffer.len())
        }
    }

    /// Scripted byte counts (or failures) for short-read and error
    /// classification. Each delivered byte carries the running stream offset,
    /// so a reassembled packet proves byte-exact coalescing.
    struct ScriptedSource {
        reads: VecDeque<Result<usize, ReadFailed>>,
        offset: u8,
    }

    impl ScriptedSource {
        fn new(reads: impl Into<VecDeque<Result<usize, ReadFailed>>>) -> Self {
            Self {
                reads: reads.into(),
                offset: 0,
            }
        }
    }

    impl PcmSource for ScriptedSource {
        fn read(&mut self, buffer: &mut [u8], _timeout_ms: u32) -> Result<usize, ReadFailed> {
            let result = self.reads.pop_front().expect("no more scripted reads");
            if let Ok(bytes) = result {
                assert!(bytes <= buffer.len(), "scripted read exceeds the tail");
                for slot in &mut buffer[..bytes] {
                    *slot = self.offset;
                    self.offset = self.offset.wrapping_add(1);
                }
            }
            result
        }
    }

    #[derive(Default)]
    struct RecordingDelay {
        waits: RefCell<Vec<u32>>,
    }

    impl Clock for RecordingDelay {
        fn monotonic_millis(&self) -> u64 {
            0
        }
    }

    impl Delay for RecordingDelay {
        fn delay_ms(&self, millis: u32) {
            self.waits.borrow_mut().push(millis);
        }
    }

    fn fill(buffer: &mut [u8], sample: i16) {
        for frame in buffer.chunks_exact_mut(BYTES_PER_FRAME) {
            frame[0..2].copy_from_slice(&sample.to_le_bytes());
            frame[2..4].copy_from_slice(&sample.to_le_bytes());
        }
    }

    fn sequence_of(packet: &AudioPacket) -> u32 {
        u32::from_le_bytes(
            packet.as_bytes()[8..12]
                .try_into()
                .expect("header sequence"),
        )
    }

    /// Drive a loud constant source until the detector reports playback, then
    /// drain the queue so a test observes only its own packets.
    fn warm_to_playing(
        engine: &mut CaptureEngine,
        queue: &PacketQueue<AudioPacket>,
        status: &StreamStatus,
    ) {
        let mut warmup = ConstantSource { sample: LOUD };
        for _ in 0..2_000 {
            engine.step(&mut warmup, Some(queue), status, &RecordingDelay::default());
            if status.snapshot().playing {
                break;
            }
        }
        assert!(status.snapshot().playing, "warm-up should start playback");
        while queue.pop_timeout(Duration::ZERO).is_some() {}
    }

    #[test]
    fn idle_input_advances_the_sequence_without_enqueuing() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new(1_440);
        let mut source = ConstantSource { sample: 0 };

        for _ in 0..50 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        let snapshot = status.snapshot();
        assert!(!snapshot.playing);
        // The sequence advanced once per idle packet; a depth of zero proves
        // nothing reached the queue.
        assert_eq!(snapshot.sequence, 50);
        assert_eq!(snapshot.queue_depth, 0);
    }

    #[test]
    fn sustained_signal_enqueues_gapped_sequences_and_reports_queue_depth() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new(1_440);
        let mut source = GatedSource { idle: 50 };

        // Drive past the warm-up and the start debounce until the input plays.
        for _ in 0..2_000 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
            if status.snapshot().playing {
                break;
            }
        }

        let snapshot = status.snapshot();
        assert!(snapshot.playing, "sustained signal should start playback");
        assert!(snapshot.queue_depth >= 1);
        // The 50 idle packets consumed sequence numbers, so the first enqueued
        // packet is numbered past the silent gap, not from zero.
        let (packet, _) = queue
            .pop_timeout(Duration::ZERO)
            .expect("a packet was enqueued");
        assert!(sequence_of(&packet) >= 50);
    }

    #[test]
    fn a_pause_gates_the_queue_while_meters_and_the_timeline_continue() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);
        let sequence_before = status.snapshot().sequence;

        status.set_streaming_enabled(false);
        let mut source = ConstantSource { sample: LOUD };
        for _ in 0..5 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        let snapshot = status.snapshot();
        // The input still plays and the meters still measure it; the pause
        // consumes sequence numbers while keeping every packet off the queue.
        assert!(snapshot.playing);
        assert!(!snapshot.streaming_enabled);
        assert_eq!(snapshot.peak_left, u32::from(LOUD as u16));
        assert_eq!(snapshot.sequence, sequence_before + 5);

        // Resuming streams again. The first packet on the queue is numbered
        // after the honest pause gap — proof the paused packets never reached
        // the wire and the timeline stayed truthful.
        status.set_streaming_enabled(true);
        engine.step(
            &mut source,
            Some(&queue),
            &status,
            &RecordingDelay::default(),
        );
        let (packet, _) = queue
            .pop_timeout(Duration::ZERO)
            .expect("a packet was enqueued");
        assert_eq!(sequence_of(&packet), sequence_before + 5);
    }

    #[test]
    fn a_transport_quiesce_gates_the_queue_like_a_pause() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);
        let sequence_before = status.snapshot().sequence;

        status.request_transport_quiesce();
        let mut source = ConstantSource { sample: LOUD };
        for _ in 0..5 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        let snapshot = status.snapshot();
        // Meters and the timeline continue; nothing reaches the queue, so the
        // network task has nothing to reconnect for while an install runs.
        assert!(snapshot.playing);
        assert_eq!(snapshot.sequence, sequence_before + 5);
        assert!(queue.pop_timeout(Duration::ZERO).is_none());

        status.end_transport_quiesce();
        engine.step(
            &mut source,
            Some(&queue),
            &status,
            &RecordingDelay::default(),
        );
        let (packet, _) = queue
            .pop_timeout(Duration::ZERO)
            .expect("a packet was enqueued");
        assert_eq!(sequence_of(&packet), sequence_before + 5);
    }

    #[test]
    fn short_reads_accumulate_without_numbering_a_packet() {
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new(1_440);
        let mut source = ScriptedSource::new([Ok(0), Ok(6), Ok(12)]);

        for _ in 0..3 {
            engine.step(&mut source, None, &status, &RecordingDelay::default());
        }

        let snapshot = status.snapshot();
        assert_eq!(snapshot.short_reads, 3);
        // Nothing completed a packet, so no read consumed a sequence number.
        assert_eq!(snapshot.sequence, 0);
    }

    #[test]
    fn short_reads_coalesce_into_one_byte_exact_packet() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);
        let sequence_before = status.snapshot().sequence;
        let short_reads_before = status.snapshot().short_reads;

        // Three reads deliver one packet: 256 + 512 + 256 bytes, each byte
        // carrying its stream offset.
        let mut source = ScriptedSource::new([Ok(256), Ok(512), Ok(256)]);
        for _ in 0..3 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        let snapshot = status.snapshot();
        // Only the reads that under-filled their tail count as short: the
        // final 256-byte read completed exactly what was requested.
        assert_eq!(snapshot.short_reads, short_reads_before + 2);
        assert_eq!(snapshot.sequence, sequence_before + 1);
        let (packet, _) = queue
            .pop_timeout(Duration::ZERO)
            .expect("a packet was enqueued");
        assert_eq!(sequence_of(&packet), sequence_before);
        let payload = &packet.as_bytes()[24..];
        let expected: Vec<u8> = (0..PAYLOAD_BYTES).map(|i| i as u8).collect();
        assert_eq!(payload, expected, "coalesced payload must be byte-exact");
    }

    #[test]
    fn a_zero_read_keeps_the_accumulated_bytes_intact() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);

        let mut source = ScriptedSource::new([Ok(100), Ok(0), Ok(924)]);
        for _ in 0..3 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        let (packet, _) = queue
            .pop_timeout(Duration::ZERO)
            .expect("a packet was enqueued");
        let payload = &packet.as_bytes()[24..];
        let expected: Vec<u8> = (0..PAYLOAD_BYTES).map(|i| i as u8).collect();
        assert_eq!(payload, expected, "a zero read must not shift the stream");
    }
    #[derive(Default)]
    struct Time(std::cell::Cell<u64>);
    impl Clock for Time {
        fn monotonic_millis(&self) -> u64 {
            self.0.get()
        }
    }
    impl Delay for Time {
        fn delay_ms(&self, millis: u32) {
            self.0.set(self.0.get() + u64::from(millis));
        }
    }

    struct TimedSource<'a> {
        clock: &'a Time,
        elapsed: u32,
        source: ScriptedSource,
    }
    impl PcmSource for TimedSource<'_> {
        fn read(&mut self, buffer: &mut [u8], timeout_ms: u32) -> Result<usize, ReadFailed> {
            assert_eq!(timeout_ms, 20);
            self.clock.delay_ms(self.elapsed);
            self.source.read(buffer, timeout_ms)
        }
    }

    #[test]
    fn failed_reads_charge_elapsed_time_including_driver_wait_and_backoff() {
        let clock = Time::default();
        let mut source = TimedSource {
            clock: &clock,
            elapsed: 20,
            source: ScriptedSource::new([Err(ReadFailed), Err(ReadFailed)]),
        };
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new(1_440);
        engine.step(&mut source, None, &status, &clock);
        assert_eq!(clock.monotonic_millis(), 30);
        assert_eq!(status.snapshot().sequence, 0);
        engine.step(&mut source, None, &status, &clock);
        assert_eq!(clock.monotonic_millis(), 60);
        assert_eq!(status.snapshot().sequence, 5); // (60 - 30) ms * 48 / 256
        assert_eq!(status.snapshot().read_errors, 2);
    }

    #[test]
    fn positive_partial_reads_cannot_keep_playing_alive_during_an_outage() {
        let clock = Time::default();
        let queue = PacketQueue::new();
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);
        let mut source = TimedSource {
            clock: &clock,
            elapsed: 20,
            source: ScriptedSource::new((0..100).map(|_| Ok(4)).collect::<VecDeque<_>>()),
        };
        for _ in 0..100 {
            engine.step(&mut source, Some(&queue), &status, &clock);
        }
        assert!(!status.snapshot().playing);
        assert!(queue.pop_timeout(Duration::ZERO).is_none());
    }

    #[test]
    fn expired_partial_packet_is_discarded_and_stereo_alignment_is_restored() {
        let clock = Time::default();
        let queue = PacketQueue::new();
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);
        let mut source = ScriptedSource::new([Ok(5), Ok(100), Ok(927)]);
        engine.step(&mut source, Some(&queue), &status, &clock);
        clock.delay_ms(40);
        engine.step(&mut source, Some(&queue), &status, &clock);
        engine.step(&mut source, Some(&queue), &status, &clock);
        let (packet, _) = queue.pop_timeout(Duration::ZERO).expect("fresh packet");
        let expected: Vec<u8> = (8..8 + PAYLOAD_BYTES).map(|n| n as u8).collect();
        assert_eq!(&packet.as_bytes()[24..], expected);
        assert_eq!(packet.age_ms(40), 30);
    }

    #[test]
    fn packet_age_includes_partial_assembly_and_dma_capacity() {
        let clock = Time(std::cell::Cell::new(100));
        let queue = PacketQueue::new();
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new(1_440);
        warm_to_playing(&mut engine, &queue, &status);
        // Establish a complete packet at the current clock before the partial read.
        engine.step(
            &mut ConstantSource { sample: LOUD },
            Some(&queue),
            &status,
            &clock,
        );
        queue.clear();
        let mut source = ScriptedSource::new([Ok(512), Ok(512)]);
        engine.step(&mut source, Some(&queue), &status, &clock);
        clock.delay_ms(10);
        engine.step(&mut source, Some(&queue), &status, &clock);
        let (packet, _) = queue.pop_timeout(Duration::ZERO).expect("assembled packet");
        assert_eq!(packet.age_ms(110), 40);
    }
}
