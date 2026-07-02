//! Play-state detection from per-packet level measurements.
//!
//! Decides whether the line input is carrying a signal worth streaming. Two
//! defenses keep the state stable on real inputs:
//!
//! - **Amplitude hysteresis**: starting requires a much louder signal than
//!   stopping. Levels wandering between the two thresholds — the noise of a
//!   floating, unterminated input lives there — never toggle the state.
//! - **Time hysteresis**: the start threshold must hold for a debounce window
//!   so clicks and pops do not start a stream, and the stop threshold must
//!   hold for seconds so gaps between tracks do not stop one.
//!
//! Hardware-independent and unit-tested on the host; the capture task feeds it
//! one [`LevelStats`] per packet.

use crate::levels::LevelStats;

/// RMS at or above which a packet counts as signal. Line-level music sits in
/// the thousands; the noise of an open input stays well below this.
pub const SIGNAL_RMS_THRESHOLD: u16 = 200;

/// RMS below which a packet counts as silent. Above the open-input noise floor
/// (~10 RMS) but below quiet passages of music.
pub const SILENCE_RMS_THRESHOLD: u16 = 50;

/// One packet is 256 frames at 48 kHz ≈ 5.3 ms.
/// Signal must persist this long to start streaming (≈ 130 ms): longer than a
/// click or a needle drop, short enough to feel immediate.
pub const START_AFTER_PACKETS: u32 = 24;

/// Silence must persist this long to stop streaming (≈ 2 s): longer than the
/// quiet gap between record tracks.
pub const STOP_AFTER_PACKETS: u32 = 375;

#[derive(Clone, Copy, Debug, Default)]
pub struct PlayDetector {
    playing: bool,
    signal_run: u32,
    silence_run: u32,
}

impl PlayDetector {
    pub const fn new() -> Self {
        Self {
            playing: false,
            signal_run: 0,
            silence_run: 0,
        }
    }

    pub const fn playing(&self) -> bool {
        self.playing
    }

    /// Fold one packet's levels into the state and return whether the input is
    /// playing. The louder channel decides, so a mono source on either channel
    /// is detected.
    pub fn update(&mut self, levels: LevelStats) -> bool {
        let rms = levels.rms_left.max(levels.rms_right);

        self.signal_run = if rms >= SIGNAL_RMS_THRESHOLD {
            self.signal_run.saturating_add(1)
        } else {
            0
        };
        self.silence_run = if rms < SILENCE_RMS_THRESHOLD {
            self.silence_run.saturating_add(1)
        } else {
            0
        };

        if self.playing {
            if self.silence_run >= STOP_AFTER_PACKETS {
                self.playing = false;
            }
        } else if self.signal_run >= START_AFTER_PACKETS {
            self.playing = true;
        }
        self.playing
    }
}

#[cfg(test)]
mod tests {
    use super::{PlayDetector, START_AFTER_PACKETS, STOP_AFTER_PACKETS};
    use crate::levels::LevelStats;

    fn rms(value: u16) -> LevelStats {
        LevelStats {
            rms_left: value,
            rms_right: value,
            ..LevelStats::default()
        }
    }

    fn feed(detector: &mut PlayDetector, level: u16, packets: u32) -> bool {
        let mut playing = detector.playing();
        for _ in 0..packets {
            playing = detector.update(rms(level));
        }
        playing
    }

    #[test]
    fn sustained_signal_starts_playback_after_the_debounce_window() {
        let mut detector = PlayDetector::new();
        assert!(!feed(&mut detector, 5_000, START_AFTER_PACKETS - 1));
        assert!(detector.update(rms(5_000)));
    }

    #[test]
    fn noise_spikes_never_start_playback() {
        let mut detector = PlayDetector::new();
        // An open input: quiet noise with brief loud transients that always
        // die before the debounce window elapses.
        for _ in 0..1_000 {
            assert!(!feed(&mut detector, 5_000, START_AFTER_PACKETS - 1));
            assert!(!detector.update(rms(10)));
        }
    }

    #[test]
    fn levels_between_the_thresholds_hold_the_current_state() {
        let mut detector = PlayDetector::new();
        // Not playing: a hum above the silence floor but below signal level
        // must not start a stream.
        assert!(!feed(&mut detector, 100, STOP_AFTER_PACKETS * 4));

        // Playing: a quiet passage in the same band must not stop one.
        feed(&mut detector, 5_000, START_AFTER_PACKETS);
        assert!(feed(&mut detector, 100, STOP_AFTER_PACKETS * 4));
    }

    #[test]
    fn a_gap_between_tracks_does_not_stop_playback() {
        let mut detector = PlayDetector::new();
        feed(&mut detector, 5_000, START_AFTER_PACKETS);
        assert!(feed(&mut detector, 0, STOP_AFTER_PACKETS - 1));
        assert!(detector.update(rms(5_000)));
    }

    #[test]
    fn sustained_silence_stops_playback() {
        let mut detector = PlayDetector::new();
        feed(&mut detector, 5_000, START_AFTER_PACKETS);
        assert!(feed(&mut detector, 0, STOP_AFTER_PACKETS - 1));
        assert!(!detector.update(rms(0)));
    }

    #[test]
    fn one_loud_channel_is_enough() {
        let mut detector = PlayDetector::new();
        let left_only = LevelStats {
            rms_left: 5_000,
            rms_right: 0,
            ..LevelStats::default()
        };
        for _ in 0..START_AFTER_PACKETS {
            detector.update(left_only);
        }
        assert!(detector.playing());
    }
}
