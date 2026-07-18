//! Capture policy: gate on signal, coalesce short reads into whole packets,
//! and enqueue with bounded latency while the sequence keeps counting through
//! idle gaps and sustained input stalls.

use std::sync::Arc;

use crate::{
    levels::LevelStats,
    packet::AudioPacket,
    play::{PlayDetector, STOP_AFTER_PACKETS},
    protocol::{BYTES_PER_FRAME, FRAMES_PER_PACKET, PAYLOAD_BYTES, SAMPLE_RATE_HZ},
};

use super::{
    effects::{Delay, PcmSource, ReadFailed},
    queue::PacketQueue,
    status::StreamStatus,
};

/// Back off this long after a stalled read — an I2S error or a zero-byte
/// yield — so a wedged input cannot spin the capture task.
const READ_STALL_BACKOFF_MS: u32 = 100;

/// Samples the input clock produces per millisecond of wall time.
const FRAMES_PER_MS: u32 = SAMPLE_RATE_HZ / 1000;

/// A stall this long is real sample loss, not DMA-buffered jitter: the same
/// two seconds after which sustained silence stops playback. Shorter stalls
/// ride on the driver's buffering and leave the timeline untouched.
const STALL_EXPIRY_MS: u32 = STOP_AFTER_PACKETS * FRAMES_PER_PACKET / FRAMES_PER_MS;

/// Owns play detection across packets; the device runs it on the capture task.
pub struct CaptureEngine {
    detector: PlayDetector,
    pcm: [u8; PAYLOAD_BYTES],
    /// Bytes of `pcm` already filled by earlier short reads. A packet is
    /// analyzed, numbered, and enqueued only once the buffer is complete, so
    /// the wire only ever carries whole 256-frame packets.
    filled: usize,
    /// Consecutive stalled-read time. Crossing [`STALL_EXPIRY_MS`] expires
    /// playback freshness and starts charging the stall to the timeline.
    stalled_ms: u32,
    /// Lost input time not yet converted into sequence numbers, in frames.
    lost_frames: u32,
}

impl CaptureEngine {
    pub fn new() -> Self {
        Self {
            detector: PlayDetector::new(),
            pcm: [0; PAYLOAD_BYTES],
            filled: 0,
            stalled_ms: 0,
            lost_frames: 0,
        }
    }

    /// Capture forever, enqueuing packets while the input plays. Without a
    /// target the queue is `None` and captured audio stops at level analysis, so
    /// the meters and calibration still work before a bridge exists.
    pub fn run(
        mut self,
        mut source: impl PcmSource,
        queue: Option<Arc<PacketQueue<AudioPacket>>>,
        status: Arc<StreamStatus>,
        delay: impl Delay,
    ) -> ! {
        loop {
            self.step(&mut source, queue.as_deref(), &status, &delay);
        }
    }

    fn step(
        &mut self,
        source: &mut impl PcmSource,
        queue: Option<&PacketQueue<AudioPacket>>,
        status: &StreamStatus,
        delay: &impl Delay,
    ) {
        if status.take_relearn() {
            self.detector = PlayDetector::new();
            status.reset_clipped();
        }
        let requested = PAYLOAD_BYTES - self.filled;
        let bytes = match source.read(&mut self.pcm[self.filled..]) {
            Ok(0) => {
                status.record_short_read();
                self.stall(status, delay);
                return;
            }
            Ok(bytes) => bytes,
            Err(ReadFailed) => {
                status.record_read_error();
                self.stall(status, delay);
                return;
            }
        };
        self.stalled_ms = 0;
        self.lost_frames = 0;
        if bytes < requested {
            // Keep what arrived byte-exactly and wait for the rest of the
            // packet; the next read continues where this one stopped.
            status.record_short_read();
        }
        self.filled += bytes.min(requested);
        if self.filled < PAYLOAD_BYTES {
            return;
        }
        self.filled = 0;
        let levels = LevelStats::analyze(&self.pcm);
        status.record_levels(levels);
        let playing = self.detector.update(levels);
        status.set_playing(playing);
        status.set_noise_floor(self.detector.noise_floor());
        let sequence = status.next_sequence();
        if !playing {
            return;
        }
        let Some(queue) = queue else {
            return;
        };
        let packet = AudioPacket::from_pcm(sequence, &self.pcm);
        let (dropped, depth) = queue.push_drop_oldest(packet);
        if dropped {
            status.record_queue_drop();
        }
        status.set_queue_depth(depth);
    }

    /// Back off after a stalled read. A stall past [`STALL_EXPIRY_MS`] is real
    /// sample loss: playback freshness expires, the stale partial packet is
    /// discarded, and the whole stall lands on the sequence timeline so the
    /// receiver sees a truthful gap instead of compressed time.
    fn stall(&mut self, status: &StreamStatus, delay: &impl Delay) {
        delay.delay_ms(READ_STALL_BACKOFF_MS);
        let already_expired = self.stalled_ms >= STALL_EXPIRY_MS;
        self.stalled_ms = self.stalled_ms.saturating_add(READ_STALL_BACKOFF_MS);
        if self.stalled_ms < STALL_EXPIRY_MS {
            return;
        }
        if already_expired {
            self.lost_frames += READ_STALL_BACKOFF_MS * FRAMES_PER_MS;
        } else {
            status.set_playing(false);
            self.lost_frames +=
                self.stalled_ms * FRAMES_PER_MS + (self.filled / BYTES_PER_FRAME) as u32;
            self.filled = 0;
        }
        while self.lost_frames >= FRAMES_PER_PACKET {
            status.next_sequence();
            self.lost_frames -= FRAMES_PER_PACKET;
        }
    }
}

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::VecDeque};

    use super::{CaptureEngine, READ_STALL_BACKOFF_MS, STALL_EXPIRY_MS};
    use crate::{
        packet::AudioPacket,
        play::STOP_AFTER_PACKETS,
        protocol::{BYTES_PER_FRAME, PAYLOAD_BYTES},
        stream::{
            effects::{Delay, PcmSource, ReadFailed},
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
        fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ReadFailed> {
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
        fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ReadFailed> {
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
        fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ReadFailed> {
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
        for _ in 0..status.snapshot().queue_depth {
            queue.pop();
        }
    }

    #[test]
    fn idle_input_advances_the_sequence_without_enqueuing() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new();
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
        let mut engine = CaptureEngine::new();
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
        let (packet, _) = queue.pop();
        assert!(sequence_of(&packet) >= 50);
    }

    #[test]
    fn short_reads_accumulate_without_numbering_a_packet() {
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new();
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
        let mut engine = CaptureEngine::new();
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
        let (packet, _) = queue.pop();
        assert_eq!(sequence_of(&packet), sequence_before);
        let payload = &packet.as_bytes()[24..];
        let expected: Vec<u8> = (0..PAYLOAD_BYTES).map(|i| i as u8).collect();
        assert_eq!(payload, expected, "coalesced payload must be byte-exact");
    }

    #[test]
    fn a_zero_read_keeps_the_accumulated_bytes_intact() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new();
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

        let (packet, _) = queue.pop();
        let payload = &packet.as_bytes()[24..];
        let expected: Vec<u8> = (0..PAYLOAD_BYTES).map(|i| i as u8).collect();
        assert_eq!(payload, expected, "a zero read must not shift the stream");
    }

    #[test]
    fn stalled_reads_back_off_without_spinning_or_numbering() {
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new();
        let mut source = ScriptedSource::new([Err(ReadFailed), Ok(0)]);
        let delay = RecordingDelay::default();

        engine.step(&mut source, None, &status, &delay);
        engine.step(&mut source, None, &status, &delay);

        let snapshot = status.snapshot();
        assert_eq!(snapshot.read_errors, 1);
        assert_eq!(snapshot.short_reads, 1);
        assert_eq!(snapshot.sequence, 0);
        // Both stall shapes back off, so neither can spin the capture task.
        assert_eq!(delay.waits.into_inner(), vec![READ_STALL_BACKOFF_MS; 2]);
    }

    #[test]
    fn a_transient_stall_keeps_playing_and_the_timeline_continuous() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new();
        warm_to_playing(&mut engine, &queue, &status);
        let sequence_before = status.snapshot().sequence;

        let mut source = ScriptedSource::new(
            (0..5)
                .map(|_| Err(ReadFailed))
                .collect::<VecDeque<Result<usize, ReadFailed>>>(),
        );
        for _ in 0..5 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        let snapshot = status.snapshot();
        // Half a second of stall rides on DMA buffering: playback stays
        // reported and no false gap lands on the timeline.
        assert!(snapshot.playing);
        assert_eq!(snapshot.sequence, sequence_before);

        let mut recovered = ConstantSource { sample: LOUD };
        for _ in 0..3 {
            engine.step(
                &mut recovered,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }
        assert_eq!(status.snapshot().sequence, sequence_before + 3);
    }

    #[test]
    fn a_sustained_stall_expires_playing_and_puts_the_gap_on_the_timeline() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new();
        warm_to_playing(&mut engine, &queue, &status);
        let sequence_before = status.snapshot().sequence;

        let stalls_to_expiry = (STALL_EXPIRY_MS / READ_STALL_BACKOFF_MS) as usize;
        let mut source = ScriptedSource::new(
            (0..stalls_to_expiry + 4)
                .map(|_| Err(ReadFailed))
                .collect::<VecDeque<Result<usize, ReadFailed>>>(),
        );
        for _ in 0..stalls_to_expiry - 1 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }
        let snapshot = status.snapshot();
        assert!(snapshot.playing, "playback must survive up to the budget");
        assert_eq!(snapshot.sequence, sequence_before);

        engine.step(
            &mut source,
            Some(&queue),
            &status,
            &RecordingDelay::default(),
        );
        let snapshot = status.snapshot();
        // Crossing the budget expires playback and charges the whole stall:
        // two seconds is exactly the detector's own silence stop budget.
        assert!(!snapshot.playing);
        assert_eq!(snapshot.sequence, sequence_before + STOP_AFTER_PACKETS);

        // Every further stall keeps the timeline honest at 4,800 frames per
        // backoff: four more backoffs are exactly 75 packets.
        for _ in 0..4 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }
        assert_eq!(
            status.snapshot().sequence,
            sequence_before + STOP_AFTER_PACKETS + 75
        );
    }

    #[test]
    fn expiry_discards_the_stale_partial_packet_and_counts_its_time() {
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut engine = CaptureEngine::new();
        warm_to_playing(&mut engine, &queue, &status);
        let sequence_before = status.snapshot().sequence;

        let stalls_to_expiry = (STALL_EXPIRY_MS / READ_STALL_BACKOFF_MS) as usize;
        let mut reads: VecDeque<Result<usize, ReadFailed>> = VecDeque::from([Ok(100)]);
        reads.extend((0..stalls_to_expiry).map(|_| Err(ReadFailed)));
        reads.push_back(Ok(PAYLOAD_BYTES));
        let mut source = ScriptedSource::new(reads);
        for _ in 0..stalls_to_expiry + 2 {
            engine.step(
                &mut source,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
        }

        // The 100 pre-stall bytes were dropped as stale: the packet after
        // recovery starts at stream offset 100 and the gap still covers the
        // full stall.
        let (packet, _) = queue.pop();
        assert_eq!(
            sequence_of(&packet),
            sequence_before + STOP_AFTER_PACKETS,
            "the recovered packet is numbered after the gap",
        );
        let payload = &packet.as_bytes()[24..];
        let expected: Vec<u8> = (100..100 + PAYLOAD_BYTES).map(|i| i as u8).collect();
        assert_eq!(payload, expected, "stale partial bytes must not be sent");
    }
}
