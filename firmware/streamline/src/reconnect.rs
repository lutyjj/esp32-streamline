//! Recovery-mode cadence for rejoining the saved Wi-Fi.
//!
//! A provisioned device that could not join its Wi-Fi runs the setup AP and
//! keeps the station side retrying the saved network in the background, so a
//! router that was only briefly down (a power cut it is still recovering from)
//! brings the device home with no user action. This unit owns only the *when*:
//! it decides from a monotonic clock whether another station attempt is due.
//! The combined AP-and-station radio mode and the attempt itself live in the
//! `wifi` adapter, and the boot loop supplies the elapsed time, so this logic
//! is host-testable away from the radio.

use std::time::Duration;

/// Wait this long after recovery starts before the first station retry, giving
/// a home router that is only moments behind the device time to finish booting.
pub const RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(30);
/// Spacing between station retries while the setup AP stays up.
pub const RECONNECT_INTERVAL: Duration = Duration::from_secs(60);

/// Monotonic schedule for background station retries in recovery mode.
///
/// The clock stays outside this unit so host tests use plain durations and the
/// ESP-IDF boot loop supplies its own monotonic elapsed time, matching
/// [`crate::update::AutoUpdateTimer`].
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ReconnectTimer {
    last_attempt: Option<Duration>,
}

impl ReconnectTimer {
    /// Reserve a due station retry. The first attempt waits
    /// [`RECONNECT_INITIAL_DELAY`] after recovery starts; later attempts are
    /// spaced by [`RECONNECT_INTERVAL`]. Returns `true` at most once per window,
    /// so the boot loop makes exactly one attempt per due tick.
    pub fn take_due(&mut self, now: Duration) -> bool {
        let due_at = self
            .last_attempt
            .map(|last| last.saturating_add(RECONNECT_INTERVAL))
            .unwrap_or(RECONNECT_INITIAL_DELAY);
        if now < due_at {
            return false;
        }
        self.last_attempt = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_attempt_waits_for_the_initial_delay() {
        let mut timer = ReconnectTimer::default();
        assert!(!timer.take_due(RECONNECT_INITIAL_DELAY - Duration::from_secs(1)));
        assert!(timer.take_due(RECONNECT_INITIAL_DELAY));
    }

    #[test]
    fn later_attempts_are_spaced_by_the_interval() {
        let mut timer = ReconnectTimer::default();
        assert!(timer.take_due(RECONNECT_INITIAL_DELAY));
        let next_due = RECONNECT_INITIAL_DELAY + RECONNECT_INTERVAL;
        assert!(!timer.take_due(next_due - Duration::from_secs(1)));
        assert!(timer.take_due(next_due));
    }

    #[test]
    fn a_due_window_yields_exactly_one_attempt() {
        let mut timer = ReconnectTimer::default();
        assert!(timer.take_due(RECONNECT_INITIAL_DELAY));
        assert!(!timer.take_due(RECONNECT_INITIAL_DELAY));
    }
}
