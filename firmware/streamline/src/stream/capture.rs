//! Capture policy: gate on signal, coalesce short reads into whole packets,
//! and enqueue with bounded latency while the sequence keeps counting through
//! idle gaps.

use std::sync::Arc;

use crate::{levels::LevelStats, packet::AudioPacket, play::PlayDetector, protocol::PAYLOAD_BYTES};

use super::{
    effects::{Delay, PcmSource, ReadFailed},
    queue::PacketQueue,
    status::StreamStatus,
};

/// Back off this long after an I2S read error before retrying, so a wedged
/// input cannot spin the capture task.
const READ_ERROR_BACKOFF_MS: u32 = 100;

/// Owns play detection across packets; the device runs it on the capture task.
pub struct CaptureEngine {
    detector: PlayDetector,
    pcm: [u8; PAYLOAD_BYTES],
    /// Bytes of `pcm` already filled by earlier short reads. A packet is
    /// analyzed, numbered, and enqueued only once the buffer is complete, so
    /// the wire only ever carries whole 256-frame packets.
    filled: usize,
}

impl CaptureEngine {
    pub fn new() -> Self {
        Self {
            detector: PlayDetector::new(),
            pcm: [0; PAYLOAD_BYTES],
            filled: 0,
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
            Ok(bytes) => bytes,
            Err(ReadFailed) => {
                status.record_read_error();
                delay.delay_ms(READ_ERROR_BACKOFF_MS);
                return;
            }
        };
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
}

impl Default for CaptureEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::VecDeque};

    use super::{CaptureEngine, READ_ERROR_BACKOFF_MS};
    use crate::{
        packet::AudioPacket,
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

        // Drive a loud constant source until the detector reports playback.
        let mut warmup = ConstantSource { sample: LOUD };
        for _ in 0..2_000 {
            engine.step(
                &mut warmup,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
            if status.snapshot().playing {
                break;
            }
        }
        assert!(status.snapshot().playing, "warm-up should start playback");
        for _ in 0..status.snapshot().queue_depth {
            queue.pop();
        }
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
        let mut warmup = ConstantSource { sample: LOUD };
        for _ in 0..2_000 {
            engine.step(
                &mut warmup,
                Some(&queue),
                &status,
                &RecordingDelay::default(),
            );
            if status.snapshot().playing {
                break;
            }
        }
        for _ in 0..status.snapshot().queue_depth {
            queue.pop();
        }

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
    fn a_read_error_is_counted_and_backed_off_without_a_packet() {
        let status = StreamStatus::default();
        let mut engine = CaptureEngine::new();
        let mut source = ScriptedSource::new([Err(ReadFailed), Err(ReadFailed)]);
        let delay = RecordingDelay::default();

        engine.step(&mut source, None, &status, &delay);
        engine.step(&mut source, None, &status, &delay);

        let snapshot = status.snapshot();
        assert_eq!(snapshot.read_errors, 2);
        assert_eq!(snapshot.sequence, 0);
        assert_eq!(delay.waits.into_inner(), vec![READ_ERROR_BACKOFF_MS; 2]);
    }
}
