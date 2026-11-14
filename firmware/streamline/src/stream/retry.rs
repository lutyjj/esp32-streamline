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

/// Consecutive failed attempts. The log carries the first cause, each changed
/// cause, and the end of the run, never every attempt.
struct Run {
    started_ms: u64,
    failures: u64,
    cause: String,
}

/// A run of failures that a delivered batch ended.
#[derive(Debug, Eq, PartialEq)]
pub struct Restored {
    pub failures: u64,
    pub elapsed_ms: u64,
}

pub struct Retry {
    delays: ExponentialBackoff,
    next_attempt_ms: Option<u64>,
    run: Option<Run>,
}

impl Retry {
    pub fn new() -> Self {
        Self {
            delays: SCHEDULE.build(),
            next_attempt_ms: None,
            run: None,
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
        match &mut self.run {
            Some(run) => {
                run.failures += 1;
                if run.cause == cause {
                    return None;
                }
                run.cause = cause;
            }
            None => {
                self.run = Some(Run {
                    started_ms: now_ms,
                    failures: 1,
                    cause,
                });
            }
        }
        self.run.as_ref().map(|run| run.cause.as_str())
    }

    /// Record a delivered batch, ending any run of failures.
    pub fn succeed(&mut self, now_ms: u64) -> Option<Restored> {
        self.restart_schedule();
        self.run.take().map(|run| Restored {
            failures: run.failures,
            elapsed_ms: now_ms.saturating_sub(run.started_ms),
        })
    }

    /// Let the next attempt run at once, as after a pause. An open run stays
    /// open, so its end is still reported.
    pub fn restart_schedule(&mut self) {
        self.delays = SCHEDULE.build();
        self.next_attempt_ms = None;
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
        assert_eq!(
            retry.succeed(3_750),
            Some(Restored {
                failures: 4,
                elapsed_ms: 3_750
            })
        );
        assert_eq!(retry.succeed(4_000), None);
        assert_eq!(retry.fail(5_000, "rejected".into()), Some("rejected"));
    }

    #[test]
    fn success_restarts_the_schedule() {
        let mut retry = Retry::new();
        spacing(&mut retry, 5);
        retry.succeed(0);
        assert_eq!(retry.wait_ms(0), 0);
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
        assert_eq!(
            retry.succeed(21_000),
            Some(Restored {
                failures: 6,
                elapsed_ms: 21_000
            })
        );
    }
}
