//! Wall-clock readiness for certificate validation.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CERTIFICATE_TIME_FLOOR: Duration = Duration::from_secs(1_735_689_600);

pub fn usable(now: SystemTime) -> bool {
    now.duration_since(UNIX_EPOCH)
        .is_ok_and(|elapsed| elapsed >= CERTIFICATE_TIME_FLOOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_and_pre_floor_clocks_need_synchronization() {
        for time in [
            UNIX_EPOCH - Duration::from_secs(1),
            UNIX_EPOCH,
            UNIX_EPOCH + CERTIFICATE_TIME_FLOOR - Duration::from_secs(1),
        ] {
            assert!(!usable(time));
        }
    }

    #[test]
    fn plausible_clock_does_not_require_another_sync() {
        assert!(usable(UNIX_EPOCH + CERTIFICATE_TIME_FLOOR));
        assert!(usable(
            UNIX_EPOCH + CERTIFICATE_TIME_FLOOR + Duration::from_secs(86_400)
        ));
    }
}
