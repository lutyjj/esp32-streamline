//! Which failures of a repeated operation reach the device log.

/// A run ends only once the operation has succeeded this long, so one that
/// recovers briefly between failures stays one run.
const RECOVERY_MS: u64 = 1_000;

/// Consecutive failures of one operation. The log carries the first cause,
/// each changed cause, and the end of the run, never every attempt.
#[derive(Default)]
pub struct FailureRun {
    run: Option<Run>,
    succeeding_since_ms: Option<u64>,
}

struct Run {
    failures: u64,
    cause: String,
}

impl FailureRun {
    /// Count a failure. Returns the cause when the log should carry it.
    pub fn fail(&mut self, cause: String) -> Option<&str> {
        self.succeeding_since_ms = None;
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

    /// Count a success. Returns the failure count of the run it ends.
    pub fn succeed(&mut self, now_ms: u64) -> Option<u64> {
        self.run.as_ref()?;
        let since = *self.succeeding_since_ms.get_or_insert(now_ms);
        if now_ms.saturating_sub(since) < RECOVERY_MS {
            return None;
        }
        self.succeeding_since_ms = None;
        self.run.take().map(|run| run.failures)
    }

    /// Restart the recovery period without counting a failure, as when a pause
    /// closes the connection whose sends were succeeding.
    pub fn interrupt(&mut self) {
        self.succeeding_since_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_reports_its_first_cause_each_change_and_its_end() {
        let mut failures = FailureRun::default();
        assert_eq!(failures.fail("refused".into()), Some("refused"));
        assert_eq!(failures.fail("refused".into()), None);
        assert_eq!(failures.fail("rejected".into()), Some("rejected"));
        assert_eq!(failures.fail("rejected".into()), None);
        assert_eq!(failures.succeed(3_000), None);
        assert_eq!(failures.succeed(4_000), Some(4));
        assert_eq!(failures.succeed(5_000), None);
        assert_eq!(failures.fail("rejected".into()), Some("rejected"));
    }

    #[test]
    fn a_failure_before_the_recovery_period_ends_keeps_the_run() {
        let mut failures = FailureRun::default();
        failures.fail("timeout".into());
        assert_eq!(failures.succeed(0), None);
        assert_eq!(failures.succeed(RECOVERY_MS - 1), None);
        assert_eq!(failures.fail("timeout".into()), None);
        assert_eq!(failures.succeed(RECOVERY_MS), None);
        assert_eq!(failures.succeed(2 * RECOVERY_MS), Some(2));
    }

    #[test]
    fn an_interruption_restarts_the_recovery_period() {
        let mut failures = FailureRun::default();
        failures.fail("timeout".into());
        failures.succeed(0);
        failures.interrupt();
        assert_eq!(failures.succeed(RECOVERY_MS), None);
        assert_eq!(failures.succeed(2 * RECOVERY_MS), Some(1));
    }

    #[test]
    fn success_without_a_failure_reports_nothing() {
        let mut failures = FailureRun::default();
        assert_eq!(failures.succeed(0), None);
        assert_eq!(failures.succeed(5_000), None);
    }
}
