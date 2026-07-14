//! LED role policy: what a board LED shows, independent of the GPIO that
//! renders it.
//!
//! A board advertises the LEDs it wires (`crate::board::Led`); the user assigns
//! each one a role. `Status` reproduces the device status light; `On` and `Off`
//! are steady overrides. A new notification — an available update, a diagnostic
//! — extends this enum with one variant and one `is_lit_at` arm, so the model
//! stays forward-looking without a matrix of every signal against every LED.

use serde::{Deserialize, Serialize};

use crate::indicator::IndicatorState;

/// The behavior assigned to a single board LED.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum LedRole {
    /// Dark: the wire is held at its inactive level.
    #[default]
    Off,
    /// Steadily lit.
    On,
    /// Renders the device status pattern (setup, ready, streaming, fault).
    Status,
}

impl LedRole {
    /// Stable API and storage name for this role.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
            Self::Status => "status",
        }
    }

    /// Decode a role name from the API or storage.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "on" => Some(Self::On),
            "status" => Some(Self::Status),
            _ => None,
        }
    }

    /// Whether a LED in this role is lit at `elapsed_ms`, given the current
    /// device status. Only `Status` consults the status pattern; the steady
    /// overrides ignore it.
    pub const fn is_lit_at(self, status: IndicatorState, elapsed_ms: u32) -> bool {
        match self {
            Self::Off => false,
            Self::On => true,
            Self::Status => status.is_lit_at(elapsed_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LedRole;
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
                assert!(!LedRole::Off.is_lit_at(state, elapsed));
                assert!(LedRole::On.is_lit_at(state, elapsed));
            }
        }
    }

    #[test]
    fn status_role_follows_the_device_status_pattern() {
        assert_eq!(
            LedRole::Status.is_lit_at(IndicatorState::Ready, 0),
            IndicatorState::Ready.is_lit_at(0)
        );
        assert!(LedRole::Status.is_lit_at(IndicatorState::Streaming, 1_500));
        assert!(!LedRole::Status.is_lit_at(IndicatorState::Ready, 200));
    }
}
