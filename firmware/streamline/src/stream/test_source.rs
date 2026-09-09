//! Hardware-test PCM that keeps the source's real read timing and failures.

use super::{PcmSource, ReadFailed};
use crate::protocol::{BYTES_PER_FRAME, SAMPLE_RATE_HZ};

const TONE_HZ: usize = 1_000;
const PERIOD_BYTES: usize = SAMPLE_RATE_HZ as usize / TONE_HZ * BYTES_PER_FRAME;

pub struct TestSource<S> {
    source: S,
    position: usize,
}

impl<S> TestSource<S> {
    pub fn new(source: S) -> Self {
        Self {
            source,
            position: 0,
        }
    }
}

impl<S: PcmSource> PcmSource for TestSource<S> {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ReadFailed> {
        let read = self.source.read(buffer)?;
        let samples = buffer.get_mut(..read).ok_or(ReadFailed)?;
        for byte in samples {
            let sample: i16 = if self.position < PERIOD_BYTES / 2 {
                1024
            } else {
                -1024
            };
            *byte = sample.to_le_bytes()[self.position % 2];
            self.position = (self.position + 1) % PERIOD_BYTES;
        }
        Ok(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ClockedSource(usize);
    impl PcmSource for ClockedSource {
        fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ReadFailed> {
            Ok(self.0.min(buffer.len()))
        }
    }

    #[test]
    fn partial_reads_preserve_waveform_and_stereo_alignment() {
        let mut source = TestSource::new(ClockedSource(3));
        let mut pcm = Vec::new();
        for _ in 0..64 {
            let mut buffer = [0_u8; 8];
            let read = source.read(&mut buffer).ok().unwrap();
            assert_eq!(read, 3);
            pcm.extend_from_slice(&buffer[..read]);
        }
        for (index, frame) in pcm.chunks_exact(4).enumerate() {
            let expected: i16 = if index < 24 { 1024 } else { -1024 };
            assert_eq!(&frame[..2], &expected.to_le_bytes());
            assert_eq!(&frame[2..], &expected.to_le_bytes());
        }
    }

    #[test]
    fn idle_read_produces_no_synthetic_samples() {
        let mut source = TestSource::new(ClockedSource(0));
        assert_eq!(source.read(&mut [0; 16]).ok(), Some(0));
    }

    #[test]
    fn tone_opens_the_real_signal_gate_without_clipping() {
        let mut source = TestSource::new(ClockedSource(crate::protocol::PAYLOAD_BYTES));
        let mut detector = crate::play::PlayDetector::new();
        let mut buffer = [0; crate::protocol::PAYLOAD_BYTES];
        for _ in 0..1_000 {
            source.read(&mut buffer).ok().unwrap();
            let levels = crate::levels::LevelStats::analyze(&buffer);
            assert_eq!(levels.clipped, 0);
            detector.update(levels);
        }
        assert!(detector.playing());
    }
}
