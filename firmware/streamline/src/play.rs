//! Play-state detection from per-packet level measurements.
//!
//! Decides whether the line input is carrying a signal worth streaming. The
//! detector calibrates itself to whatever is plugged in — it tracks the
//! input's idle level and derives both decision thresholds from it, so no
//! constant has to fit every source, cable, and attenuation setting. Four
//! defenses keep the state stable on real inputs:
//!
//! - **Idle-level tracking**: a median-seeking estimate of packet RMS moves a
//!   fixed small step toward every packet, so it settles on the noise's
//!   typical level and neither spikes nor dips can drag it around. While
//!   playing, only packets already below the stop threshold feed it, so music
//!   cannot lift it.
//! - **Boot warm-up**: for the first two seconds the detector only learns.
//!   The codec's power-up transient is loud enough to pass any threshold and
//!   must never start a stream.
//! - **Amplitude hysteresis**: starting requires a level several times the
//!   idle level; stopping requires falling back toward it. Levels between the
//!   two thresholds hold the current state.
//! - **Time hysteresis with outlier tolerance**: the start level must hold
//!   for a debounce window so clicks and pops do not start a stream. Stopping
//!   charges a counter across seconds of quiet packets, and an occasional
//!   noise burst discharges it a little instead of resetting it — an idle
//!   input whose noise sometimes spikes over the stop threshold still stops.
//!
//! Hardware-independent and unit-tested on the host; the capture task feeds it
//! one [`LevelStats`] per packet.

use crate::levels::LevelStats;

/// Starting requires this multiple of the idle level. Idle noise peaks at
/// roughly twice its median on real inputs; program material sits far above.
const START_IDLE_FACTOR: u32 = 3;

/// Start threshold never drops below this RMS, keeping clicks on a
/// near-silent input (idle level ≈ 0) from starting a stream.
const START_RMS_MIN: u32 = 150;

/// Stopping requires falling below this multiple of the idle level.
const STOP_IDLE_FACTOR: u32 = 2;

/// Stop threshold never drops below this RMS, so the silence gate works while
/// the idle estimate is still converging.
const STOP_RMS_MIN: u32 = 60;

/// One packet is 256 frames at 48 kHz ≈ 5.3 ms.
/// Signal must persist this long to start streaming (≈ 130 ms): longer than a
/// click or a needle drop, short enough to feel immediate.
pub const START_AFTER_PACKETS: u32 = 24;

/// Quiet packets must accumulate this charge to stop streaming (≈ 2 s of
/// silence): longer than the quiet gap between record tracks.
pub const STOP_AFTER_PACKETS: u32 = 375;

/// A packet at or above the stop threshold removes this much silence charge.
/// Stopping therefore needs quiet packets to outnumber loud ones better than
/// eight to one — rare noise bursts only delay the stop, while real audio,
/// which is loud far more often, pins the charge at zero.
const SILENCE_DISCHARGE: u32 = 8;

/// Learn-only packets after boot (≈ 2 s): long enough for the codec's
/// power-up transient to pass and the idle estimate to converge.
const WARMUP_PACKETS: u32 = 375;

/// Idle-estimate step per packet in 1/256 RMS units (0.25 RMS, ≈ 47 RMS/s):
/// converges from cold inside the warm-up window, yet a three-minute track
/// moves the gated estimate by at most a few dozen RMS.
const IDLE_STEP_X256: u32 = 64;

#[derive(Clone, Copy, Debug, Default)]
pub struct PlayDetector {
    playing: bool,
    warmup: u32,
    signal_run: u32,
    silence_charge: u32,
    /// Idle-level RMS estimate in 1/256 units for sub-integer steps.
    idle_x256: u32,
}

impl PlayDetector {
    pub const fn new() -> Self {
        Self {
            playing: false,
            warmup: WARMUP_PACKETS,
            signal_run: 0,
            silence_charge: 0,
            idle_x256: 0,
        }
    }

    pub const fn playing(&self) -> bool {
        self.playing
    }

    /// Current idle-level RMS estimate, exposed as the noise floor in
    /// telemetry.
    pub const fn noise_floor(&self) -> u16 {
        (self.idle_x256 >> 8) as u16
    }

    /// Fold one packet's levels into the state and return whether the input is
    /// playing. The louder channel decides, so a mono source on either channel
    /// is detected.
    pub fn update(&mut self, levels: LevelStats) -> bool {
        let rms = u32::from(levels.rms_left.max(levels.rms_right));
        let stop = self.stop_threshold();
        let start = self.start_threshold();
        self.learn_idle(rms, stop);

        if self.warmup > 0 {
            self.warmup -= 1;
            return false;
        }

        self.signal_run = if rms >= start {
            self.signal_run.saturating_add(1)
        } else {
            0
        };
        self.silence_charge = if rms < stop {
            (self.silence_charge + 1).min(STOP_AFTER_PACKETS)
        } else {
            self.silence_charge.saturating_sub(SILENCE_DISCHARGE)
        };

        if self.playing {
            if self.silence_charge >= STOP_AFTER_PACKETS {
                self.playing = false;
            }
        } else if self.signal_run >= START_AFTER_PACKETS {
            self.playing = true;
            // Pre-start silence must not count toward the next stop.
            self.silence_charge = 0;
        }
        self.playing
    }

    fn start_threshold(&self) -> u32 {
        (u32::from(self.noise_floor()) * START_IDLE_FACTOR).max(START_RMS_MIN)
    }

    fn stop_threshold(&self) -> u32 {
        (u32::from(self.noise_floor()) * STOP_IDLE_FACTOR).max(STOP_RMS_MIN)
    }

    /// Step the idle estimate toward this packet's RMS. While playing, only
    /// packets already below the stop threshold — track gaps, real silence —
    /// are trusted; everything else is program material and is ignored.
    fn learn_idle(&mut self, rms: u32, stop_threshold: u32) {
        if self.playing && rms >= stop_threshold {
            return;
        }
        let target = rms << 8;
        if target > self.idle_x256 {
            self.idle_x256 += IDLE_STEP_X256;
        } else {
            self.idle_x256 = self.idle_x256.saturating_sub(IDLE_STEP_X256);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PlayDetector, START_AFTER_PACKETS, STOP_AFTER_PACKETS, WARMUP_PACKETS};
    use crate::levels::LevelStats;

    /// Idle-input RMS (max of both channels) from a powered-on, non-playing CD
    /// player: median 23 with excursions to 89.
    const IDLE_CD_PLAYER_RMS: [u16; 120] = [
        13, 17, 26, 20, 69, 13, 27, 23, 17, 20, 20, 14, 24, 20, 59, 28, 31, 41, 89, 20, 24, 24, 13,
        12, 28, 25, 20, 26, 24, 16, 15, 24, 32, 11, 14, 21, 43, 20, 45, 27, 41, 28, 25, 30, 27, 22,
        15, 33, 39, 18, 27, 31, 34, 10, 24, 21, 19, 22, 15, 20, 20, 13, 39, 50, 13, 45, 15, 25, 15,
        29, 21, 27, 22, 28, 25, 18, 19, 25, 22, 66, 24, 21, 78, 21, 23, 14, 50, 15, 20, 37, 28, 18,
        36, 16, 33, 18, 21, 12, 23, 27, 40, 17, 26, 25, 48, 26, 26, 39, 18, 12, 26, 16, 17, 19, 20,
        19, 15, 35, 15, 26,
    ];

    /// The same input sampled right after a reboot, when the noise runs
    /// hotter and burstier: median 51 with excursions to 120 — a wider shape
    /// that a threshold anchored to the noise minimum cannot separate.
    const IDLE_CD_PLAYER_RMS_HOT: [u16; 240] = [
        40, 30, 55, 48, 89, 55, 39, 85, 28, 31, 62, 57, 60, 56, 38, 61, 40, 69, 46, 23, 68, 48, 57,
        51, 32, 76, 14, 91, 73, 76, 44, 15, 43, 48, 40, 65, 85, 10, 74, 79, 82, 66, 66, 46, 47, 80,
        76, 55, 63, 89, 59, 42, 79, 69, 75, 24, 39, 22, 48, 39, 59, 69, 61, 16, 80, 46, 69, 25, 17,
        26, 64, 22, 15, 39, 26, 80, 61, 20, 66, 54, 40, 88, 32, 94, 72, 68, 45, 27, 71, 16, 16, 53,
        61, 38, 45, 20, 22, 20, 59, 72, 53, 67, 45, 68, 46, 19, 32, 75, 71, 51, 22, 20, 53, 52, 31,
        70, 13, 41, 27, 57, 116, 35, 36, 8, 66, 87, 63, 33, 34, 30, 24, 52, 88, 45, 78, 86, 58, 19,
        88, 42, 67, 58, 47, 75, 21, 96, 55, 74, 55, 65, 74, 46, 22, 51, 95, 24, 35, 80, 44, 56, 9,
        27, 57, 64, 85, 24, 98, 82, 84, 28, 17, 49, 40, 84, 45, 58, 40, 60, 76, 20, 28, 70, 8, 42,
        16, 72, 91, 45, 69, 22, 24, 29, 30, 18, 16, 120, 61, 13, 15, 15, 37, 86, 19, 79, 59, 53,
        12, 16, 57, 47, 50, 20, 28, 73, 65, 93, 14, 46, 31, 34, 59, 79, 61, 29, 64, 49, 68, 57, 54,
        32, 24, 33, 21, 45, 61, 69, 16, 53, 52, 47,
    ];

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

    fn feed_noise(detector: &mut PlayDetector, fixture: &[u16], packets: u32) -> bool {
        let mut playing = detector.playing();
        for index in 0..packets {
            playing = detector.update(rms(fixture[index as usize % fixture.len()]));
        }
        playing
    }

    /// A detector past its boot warm-up, with the idle estimate converged on
    /// the given fixture.
    fn settled(fixture: &[u16]) -> PlayDetector {
        let mut detector = PlayDetector::new();
        feed_noise(&mut detector, fixture, WARMUP_PACKETS + 2_000);
        assert!(!detector.playing());
        detector
    }

    #[test]
    fn sustained_signal_starts_playback_after_the_debounce_window() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
        assert!(!feed(&mut detector, 5_000, START_AFTER_PACKETS - 1));
        assert!(detector.update(rms(5_000)));
    }

    #[test]
    fn the_boot_transient_never_starts_playback() {
        let mut detector = PlayDetector::new();
        // Codec power-up: a loud transient spanning the whole warm-up window,
        // then idle noise.
        assert!(!feed(&mut detector, 5_000, WARMUP_PACKETS));
        assert!(!feed_noise(&mut detector, &IDLE_CD_PLAYER_RMS, 4_000));
    }

    #[test]
    fn noise_spikes_never_start_playback() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
        // Brief loud transients that always die before the debounce window.
        for _ in 0..1_000 {
            assert!(!feed(&mut detector, 5_000, START_AFTER_PACKETS - 1));
            assert!(!detector.update(rms(10)));
        }
    }

    #[test]
    fn a_hum_below_the_start_threshold_never_starts_a_stream() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
        assert!(!feed(&mut detector, 100, STOP_AFTER_PACKETS * 4));
    }

    #[test]
    fn a_quiet_passage_above_the_stop_threshold_never_stops_a_stream() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
        feed(&mut detector, 5_000, START_AFTER_PACKETS);
        assert!(feed(&mut detector, 200, STOP_AFTER_PACKETS * 4));
    }

    #[test]
    fn a_gap_between_tracks_does_not_stop_playback() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
        feed(&mut detector, 5_000, START_AFTER_PACKETS);
        assert!(feed(&mut detector, 0, STOP_AFTER_PACKETS - 1));
        assert!(detector.update(rms(5_000)));
    }

    #[test]
    fn sustained_silence_stops_playback() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
        feed(&mut detector, 5_000, START_AFTER_PACKETS);
        assert!(feed(&mut detector, 0, STOP_AFTER_PACKETS - 1));
        assert!(!detector.update(rms(0)));
    }

    #[test]
    fn recorded_idle_noise_never_starts_playback() {
        settled(&IDLE_CD_PLAYER_RMS);
        settled(&IDLE_CD_PLAYER_RMS_HOT);
    }

    #[test]
    fn recorded_idle_noise_stops_a_running_stream() {
        // Bursts above the stop threshold discharge the silence counter
        // instead of resetting it, so both measured noise regimes stop within
        // tens of seconds instead of streaming forever.
        for fixture in [&IDLE_CD_PLAYER_RMS[..], &IDLE_CD_PLAYER_RMS_HOT[..]] {
            let mut detector = settled(fixture);
            feed(&mut detector, 5_000, START_AFTER_PACKETS);
            assert!(!feed_noise(&mut detector, fixture, 8_000));
        }
    }

    #[test]
    fn the_idle_estimate_settles_on_the_typical_noise_level() {
        let quiet = settled(&IDLE_CD_PLAYER_RMS).noise_floor();
        assert!((15..=35).contains(&quiet), "estimate {quiet} off median 23");

        let hot = settled(&IDLE_CD_PLAYER_RMS_HOT).noise_floor();
        assert!((40..=65).contains(&hot), "estimate {hot} off median 51");
    }

    #[test]
    fn one_loud_channel_is_enough() {
        let mut detector = settled(&IDLE_CD_PLAYER_RMS);
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
