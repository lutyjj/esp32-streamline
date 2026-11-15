//! When the PCM sender retries after a failure, and which failures it logs.

use super::failure_run::FailureRun;
use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use std::time::Duration;

/// The first retry waits about the queue's 256 ms retention, so one failure
/// costs little audio. The cap matches the bridge's Sendspin reconnect cap.
const MIN_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(30);
const SCHEDULE: ExponentialBuilder = ExponentialBuilder::new()
    .with_min_delay(MIN_DELAY)
    .with_max_delay(MAX_DELAY)
    .without_max_times();

/// After this long without queue storage the sender asks for a restart, which
/// releases the fragmented heap.
const STORAGE_WAIT_MS: u64 = 60_000;

pub struct Retry {
    delays: ExponentialBackoff,
    next_attempt_ms: Option<u64>,
    failures: FailureRun,
    storage_refused_ms: Option<u64>,
}

impl Retry {
    pub fn new() -> Self {
        Self {
            delays: SCHEDULE.build(),
            next_attempt_ms: None,
            failures: FailureRun::default(),
            storage_refused_ms: None,
        }
    }

    /// Milliseconds until the next attempt may run; zero when it may run now.
    pub fn wait_ms(&self, now_ms: u64) -> u64 {
        self.next_attempt_ms
            .map_or(0, |at| at.saturating_sub(now_ms))
    }

    /// Schedule the next attempt after a failure. Returns the cause when the
    /// log should carry it.
    pub fn fail(&mut self, now_ms: u64, cause: String) -> Option<&str> {
        let delay = self.delays.next().unwrap_or(MAX_DELAY);
        self.next_attempt_ms = Some(now_ms.saturating_add(delay.as_millis() as u64));
        self.failures.fail(cause)
    }

    /// Record a delivered batch. Returns the failure count of the run it ends.
    /// Only that end restarts the schedule, so a bridge that accepts each
    /// connection and then closes it stays on the schedule.
    pub fn deliver(&mut self, now_ms: u64) -> Option<u64> {
        let failures = self.failures.succeed(now_ms)?;
        self.restart_schedule();
        Some(failures)
    }

    /// Record a resume the heap refused. Returns whether refusals have lasted
    /// long enough to restart.
    pub fn refuse_storage(&mut self, now_ms: u64) -> bool {
        let since = *self.storage_refused_ms.get_or_insert(now_ms);
        now_ms.saturating_sub(since) >= STORAGE_WAIT_MS
    }

    /// Record a reserved resume. Returns whether the heap had refused it.
    pub fn reserve_storage(&mut self) -> bool {
        self.storage_refused_ms.take().is_some()
    }

    /// Let the next attempt run at once, as after a pause, which also closes
    /// the connection. An open run stays open, so its end is still reported.
    pub fn restart_schedule(&mut self) {
        self.delays = SCHEDULE.build();
        self.next_attempt_ms = None;
        self.failures.interrupt();
        self.storage_refused_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spacing(retry: &mut Retry, failures: usize) -> Vec<u64> {
        let mut now = 0;
        (0..failures)
            .map(|_| {
                retry.fail(now, "refused".into());
                let wait = retry.wait_ms(now);
                now += wait;
                wait
            })
            .collect()
    }

    #[test]
    fn consecutive_failures_double_the_wait_up_to_thirty_seconds() {
        assert_eq!(
            spacing(&mut Retry::new(), 9),
            [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
        );
    }

    #[test]
    fn the_wait_counts_down_from_the_failure() {
        let mut retry = Retry::new();
        assert_eq!(retry.wait_ms(0), 0);
        retry.fail(1_000, "refused".into());
        assert_eq!(retry.wait_ms(1_100), 150);
        assert_eq!(retry.wait_ms(1_250), 0);
        assert_eq!(retry.wait_ms(9_000), 0);
    }

    #[test]
    fn a_connection_dropped_within_a_second_keeps_the_run_and_its_schedule() {
        let mut retry = Retry::new();
        retry.fail(0, "refused".into());
        assert_eq!(retry.deliver(250), None);
        assert_eq!(retry.deliver(1_249), None);
        assert_eq!(retry.fail(1_249, "reset".into()), Some("reset"));
        assert_eq!(retry.wait_ms(1_249), 500);
        assert_eq!(retry.deliver(1_749), None);
        assert_eq!(retry.deliver(2_749), Some(2));
        assert_eq!(retry.fail(2_749, "reset".into()), Some("reset"));
        assert_eq!(retry.wait_ms(2_749), 250);
    }

    #[test]
    fn success_restarts_the_schedule() {
        let mut retry = Retry::new();
        spacing(&mut retry, 5);
        retry.deliver(0);
        assert_eq!(retry.deliver(1_000), Some(5));
        assert_eq!(retry.wait_ms(1_000), 0);
        assert_eq!(spacing(&mut retry, 2), [250, 500]);
    }

    #[test]
    fn a_restarted_schedule_keeps_the_run_open() {
        let mut retry = Retry::new();
        spacing(&mut retry, 5);
        retry.restart_schedule();
        assert_eq!(retry.wait_ms(0), 0);
        assert_eq!(retry.fail(20_000, "refused".into()), None);
        assert_eq!(retry.wait_ms(20_000), 250);
        retry.deliver(21_000);
        assert_eq!(retry.deliver(22_000), Some(6));
    }

    #[test]
    fn storage_refused_for_a_minute_asks_for_a_restart_until_it_is_reserved() {
        let mut retry = Retry::new();
        assert!(!retry.refuse_storage(1_000));
        assert!(!retry.refuse_storage(1_000 + STORAGE_WAIT_MS - 1));
        assert!(retry.refuse_storage(1_000 + STORAGE_WAIT_MS));
        retry.reserve_storage();
        assert!(!retry.refuse_storage(2 * STORAGE_WAIT_MS));
        retry.restart_schedule();
        assert!(!retry.refuse_storage(4 * STORAGE_WAIT_MS));
    }
}
