//! Station retry cadence, and the sustained-loss rule that hands a provisioned
//! device to recovery.
//!
//! The boot loop supplies elapsed time and the Wi-Fi adapter attempts association.

use std::time::Duration;

/// Wait this long after the boot loop starts before the first station retry,
/// giving a home router that powered up with the device time to finish booting.
pub const RECONNECT_INITIAL_DELAY: Duration = Duration::from_secs(30);
/// Spacing between station retries.
pub const RECONNECT_INTERVAL: Duration = Duration::from_secs(60);
/// How long a provisioned device retries a lost station link in place. After
/// that it restarts, because the mode is fixed at boot, and boot opens the
/// setup network beside the retries while the network stays absent. ESPHome
/// raises its fallback hotspot after the same 90 seconds, without a restart.
pub const RECOVERY_AFTER: Duration = Duration::from_secs(90);

/// Monotonic schedule for background station retries.
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
    /// [`RECONNECT_INITIAL_DELAY`] after the boot loop starts; later attempts are
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

/// What the provisioned boot loop does about its station link on one tick.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinkAction {
    /// The link is up, or the next retry is not due yet.
    Wait,
    /// Attempt one station association.
    Retry,
    /// The link has stayed down for [`RECOVERY_AFTER`]: restart into the boot
    /// path. Repeats every tick until the restart is admitted or the link returns.
    Restart,
}

/// Station supervision for a provisioned boot: retries on the
/// [`ReconnectTimer`] cadence, then hands a sustained loss to recovery.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LinkSupervisor {
    retries: ReconnectTimer,
    lost_since: Option<Duration>,
}

impl LinkSupervisor {
    pub fn tick(&mut self, now: Duration, connected: bool) -> LinkAction {
        if connected {
            self.lost_since = None;
            return LinkAction::Wait;
        }
        let lost_since = *self.lost_since.get_or_insert(now);
        if now.saturating_sub(lost_since) >= RECOVERY_AFTER {
            LinkAction::Restart
        } else if self.retries.take_due(now) {
            LinkAction::Retry
        } else {
            LinkAction::Wait
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);
    /// A loss well after boot, when the retry cadence is already due.
    const LOST_AT: Duration = Duration::from_secs(3_600);

    #[test]
    fn first_attempt_waits_for_the_initial_delay() {
        let mut timer = ReconnectTimer::default();
        assert!(!timer.take_due(RECONNECT_INITIAL_DELAY - SECOND));
        assert!(timer.take_due(RECONNECT_INITIAL_DELAY));
    }

    #[test]
    fn later_attempts_are_spaced_by_the_interval() {
        let mut timer = ReconnectTimer::default();
        assert!(timer.take_due(RECONNECT_INITIAL_DELAY));
        let next_due = RECONNECT_INITIAL_DELAY + RECONNECT_INTERVAL;
        assert!(!timer.take_due(next_due - SECOND));
        assert!(timer.take_due(next_due));
    }

    #[test]
    fn a_due_window_yields_exactly_one_attempt() {
        let mut timer = ReconnectTimer::default();
        assert!(timer.take_due(RECONNECT_INITIAL_DELAY));
        assert!(!timer.take_due(RECONNECT_INITIAL_DELAY));
    }

    #[test]
    fn a_connected_link_never_acts() {
        let mut link = LinkSupervisor::default();
        for now in [Duration::ZERO, LOST_AT, LOST_AT + RECOVERY_AFTER * 10] {
            assert_eq!(link.tick(now, true), LinkAction::Wait);
        }
    }

    #[test]
    fn a_lost_link_retries_in_place_before_the_recovery_window_closes() {
        let mut link = LinkSupervisor::default();
        assert_eq!(link.tick(LOST_AT, false), LinkAction::Retry);
        assert_eq!(link.tick(LOST_AT + SECOND, false), LinkAction::Wait);
        assert_eq!(
            link.tick(LOST_AT + RECONNECT_INTERVAL, false),
            LinkAction::Retry
        );
        assert_eq!(
            link.tick(LOST_AT + RECOVERY_AFTER - SECOND, false),
            LinkAction::Wait
        );
    }

    #[test]
    fn a_sustained_loss_restarts_until_the_restart_is_admitted() {
        let mut link = LinkSupervisor::default();
        link.tick(LOST_AT, false);
        assert_eq!(
            link.tick(LOST_AT + RECOVERY_AFTER, false),
            LinkAction::Restart
        );
        assert_eq!(
            link.tick(LOST_AT + RECOVERY_AFTER + SECOND, false),
            LinkAction::Restart
        );
    }

    #[test]
    fn a_returning_link_restarts_the_recovery_window() {
        let mut link = LinkSupervisor::default();
        link.tick(LOST_AT, false);
        let back_at = LOST_AT + RECOVERY_AFTER - SECOND;
        assert_eq!(link.tick(back_at, true), LinkAction::Wait);
        let lost_again = back_at + SECOND;
        link.tick(lost_again, false);
        assert_ne!(
            link.tick(lost_again + RECOVERY_AFTER - SECOND, false),
            LinkAction::Restart
        );
        assert_eq!(
            link.tick(lost_again + RECOVERY_AFTER, false),
            LinkAction::Restart
        );
    }
}
