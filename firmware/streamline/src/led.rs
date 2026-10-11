//! LED role policy: what a board LED shows, independent of the GPIO that
//! renders it.
//!
//! The API crate owns role values. Firmware maps a role and current device
//! status to a light level; the GPIO adapter applies that level.

use crate::indicator::IndicatorState;
use streamline_api::controls::LedRole;

/// Whether a LED in this role is lit at `elapsed_ms`, given the current
/// device status. Only `Status` consults the status pattern; the steady
/// overrides ignore it.
pub const fn is_lit_at(role: LedRole, status: IndicatorState, elapsed_ms: u32) -> bool {
    match role {
        LedRole::Off => false,
        LedRole::On => true,
        LedRole::Status => status.is_lit_at(elapsed_ms),
    }
}

#[cfg(test)]
mod tests {
    use super::{is_lit_at, LedRole};
    use crate::indicator::IndicatorState;

    #[test]
    fn roles_have_stable_api_and_storage_names() {
        for (name, role) in [
            ("off", LedRole::Off),
            ("on", LedRole::On),
            ("status", LedRole::Status),
        ] {
            assert_eq!(role.as_str(), name);
            assert_eq!(LedRole::parse(name), Some(role));
        }
        assert_eq!(LedRole::parse("blink"), None);
        assert_eq!(LedRole::default(), LedRole::Off);
    }

    #[test]
    fn steady_roles_ignore_the_status_pattern() {
        for state in [
            IndicatorState::Setup,
            IndicatorState::Ready,
            IndicatorState::Streaming,
            IndicatorState::Fault,
        ] {
            for elapsed in [0, 200, 500, 1_500] {
                assert!(!is_lit_at(LedRole::Off, state, elapsed));
                assert!(is_lit_at(LedRole::On, state, elapsed));
            }
        }
    }

    #[test]
    fn status_role_follows_the_device_status_pattern() {
        assert_eq!(
            is_lit_at(LedRole::Status, IndicatorState::Ready, 0),
            IndicatorState::Ready.is_lit_at(0)
        );
        assert!(is_lit_at(LedRole::Status, IndicatorState::Streaming, 1_500));
        assert!(!is_lit_at(LedRole::Status, IndicatorState::Ready, 200));
    }
}
