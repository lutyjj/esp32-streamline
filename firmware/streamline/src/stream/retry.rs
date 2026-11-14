//! When the PCM sender retries after a failure, and which failures it logs.

use backon::{BackoffBuilder, ExponentialBackoff, ExponentialBuilder};
use std::time::Duration;

/// The first retry waits about the queue's 256 ms retention, so one failure
/// costs little audio. The cap matches the bridge's Sendspin reconnect cap and
/// bounds ESP-IDF's own TLS error lines, two per failed handshake, to four a
/// minute.
const MIN_DELAY: Duration = Duration::from_millis(250);
const MAX_DELAY: Duration = Duration::from_secs(30);
const SCHEDULE: ExponentialBuilder = ExponentialBuilder::new()
    .with_min_delay(MIN_DELAY)
    .with_max_delay(MAX_DELAY)
    .without_max_times();

/// A run of failures ends only once one connection has delivered this long, so
/// a bridge that accepts a connection and then closes it stays on the schedule.
const MIN_UPTIME_MS: u64 = 1_000;

/// Consecutive failed attempts. The log carries the first cause, each changed
/// cause, and the end of the run, never every attempt.
struct Run {
    failures: u64,
    cause: String,
}

pub struct Retry {
    delays: ExponentialBackoff,
    next_attempt_ms: Option<u64>,
    run: Option<Run>,
    connected_ms: Option<u64>,
}

impl Retry {
    pub fn new() -> Self {
        Self {
            delays: SCHEDULE.build(),
            next_attempt_ms: None,
            run: None,
            connected_ms: None,
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
        self.connected_ms = None;
        match &mut self.run {
            Some(run) => {
                run.failures += 1;
                if run.cause == cause {
                    return None;
                }
                run.cause = cause;
            }
            None => self.run = Some(Run { failures: 1, cause }),
        }
        self.run.as_ref().map(|run| run.cause.as_str())
    }

    /// Record a delivered batch. Returns the failure count of the run it ends.
    pub fn deliver(&mut self, now_ms: u64, new_connection: bool) -> Option<u64> {
        if new_connection {
            self.connected_ms = Some(now_ms);
        }
        let connected_ms = self.connected_ms?;
        if self.run.is_none() || now_ms.saturating_sub(connected_ms) < MIN_UPTIME_MS {
            return None;
        }
        self.restart_schedule();
        self.run.take().map(|run| run.failures)
    }

    /// Let the next attempt run at once, as after a pause, which also closes
    /// the connection. An open run stays open, so its end is still reported.
    pub fn restart_schedule(&mut self) {
        self.delays = SCHEDULE.build();
        self.next_attempt_ms = None;
        self.connected_ms = None;
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
    fn a_run_reports_its_first_cause_each_change_and_its_end() {
        let mut retry = Retry::new();
        assert_eq!(retry.fail(0, "refused".into()), Some("refused"));
        assert_eq!(retry.fail(250, "refused".into()), None);
        assert_eq!(retry.fail(750, "rejected".into()), Some("rejected"));
        assert_eq!(retry.fail(1_750, "rejected".into()), None);
        assert_eq!(retry.deliver(3_750, true), None);
        assert_eq!(retry.deliver(4_750, false), Some(4));
        assert_eq!(retry.deliver(5_000, false), None);
        assert_eq!(retry.fail(5_000, "rejected".into()), Some("rejected"));
    }

    #[test]
    fn a_connection_dropped_before_the_minimum_uptime_keeps_the_run_and_its_schedule() {
        let mut retry = Retry::new();
        retry.fail(0, "refused".into());
        assert_eq!(retry.deliver(250, true), None);
        assert_eq!(retry.deliver(1_249, false), None);
        assert_eq!(retry.fail(1_249, "reset".into()), Some("reset"));
        assert_eq!(retry.wait_ms(1_249), 500);
        assert_eq!(retry.deliver(1_749, true), None);
        assert_eq!(retry.deliver(2_749, false), Some(2));
        assert_eq!(retry.fail(2_749, "reset".into()), Some("reset"));
        assert_eq!(retry.wait_ms(2_749), 250);
    }

    #[test]
    fn delivery_without_a_failure_reports_nothing() {
        let mut retry = Retry::new();
        assert_eq!(retry.deliver(0, true), None);
        assert_eq!(retry.deliver(5_000, false), None);
    }

    #[test]
    fn success_restarts_the_schedule() {
        let mut retry = Retry::new();
        spacing(&mut retry, 5);
        retry.deliver(0, true);
        assert_eq!(retry.deliver(MIN_UPTIME_MS, false), Some(5));
        assert_eq!(retry.wait_ms(MIN_UPTIME_MS), 0);
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
        retry.deliver(21_000, true);
        assert_eq!(retry.deliver(22_000, false), Some(6));
    }
}
