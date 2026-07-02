//! Pure audio level analysis for one captured packet.
//!
//! Kept hardware-independent so it is unit-tested on the host and reused by the
//! capture task to surface real peak/RMS/clipping telemetry.

/// Absolute sample value at or above which a sample is counted as clipped.
/// Just below full scale to catch hard limiting without flagging normal peaks.
pub const CLIP_THRESHOLD_ABS: u16 = 32_760;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LevelStats {
    pub peak_left: u16,
    pub peak_right: u16,
    pub rms_left: u16,
    pub rms_right: u16,
    pub clipped: u32,
}

impl LevelStats {
    /// Analyze interleaved 16-bit little-endian stereo PCM. Trailing bytes that
    /// do not complete a stereo frame are ignored.
    pub fn analyze(pcm: &[u8]) -> Self {
        let mut peak_left = 0;
        let mut peak_right = 0;
        let mut sum_sq_left = 0_u64;
        let mut sum_sq_right = 0_u64;
        let mut clipped = 0;
        let mut frames = 0_u64;
        for frame in pcm.chunks_exact(4) {
            let left = i16::from_le_bytes([frame[0], frame[1]]).unsigned_abs();
            let right = i16::from_le_bytes([frame[2], frame[3]]).unsigned_abs();
            peak_left = peak_left.max(left);
            peak_right = peak_right.max(right);
            sum_sq_left += u64::from(left) * u64::from(left);
            sum_sq_right += u64::from(right) * u64::from(right);
            clipped += u32::from(left >= CLIP_THRESHOLD_ABS);
            clipped += u32::from(right >= CLIP_THRESHOLD_ABS);
            frames += 1;
        }
        Self {
            peak_left,
            peak_right,
            rms_left: rms(sum_sq_left, frames),
            rms_right: rms(sum_sq_right, frames),
            clipped,
        }
    }
}

fn rms(sum_sq: u64, frames: u64) -> u16 {
    if frames == 0 {
        return 0;
    }
    (sum_sq as f64 / frames as f64).sqrt() as u16
}

#[cfg(test)]
mod tests {
    use super::{LevelStats, CLIP_THRESHOLD_ABS};

    fn frame(left: i16, right: i16) -> [u8; 4] {
        let mut bytes = [0; 4];
        bytes[0..2].copy_from_slice(&left.to_le_bytes());
        bytes[2..4].copy_from_slice(&right.to_le_bytes());
        bytes
    }

    #[test]
    fn measures_peak_rms_and_clipping_per_channel() {
        let pcm: Vec<u8> = [frame(100, -200), frame(-50, 32_767), frame(0, 32_000)]
            .concat()
            .to_vec();
        let stats = LevelStats::analyze(&pcm);

        assert_eq!(stats.peak_left, 100);
        assert_eq!(stats.peak_right, 32_767);
        // Only the full-scale right sample crosses the clip threshold.
        assert_eq!(stats.clipped, 1);
        assert!(stats.rms_right > stats.rms_left);
    }

    #[test]
    fn full_scale_negative_sample_does_not_overflow() {
        let stats = LevelStats::analyze(&frame(i16::MIN, i16::MIN));
        assert_eq!(stats.peak_left, 32_768);
        assert_eq!(stats.clipped, 2);
        assert!(i16::MIN.unsigned_abs() >= CLIP_THRESHOLD_ABS);
    }

    #[test]
    fn ignores_partial_trailing_frame() {
        assert_eq!(LevelStats::analyze(&[1, 2, 3]), LevelStats::default());
    }
}
