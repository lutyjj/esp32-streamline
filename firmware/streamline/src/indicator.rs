//! Status-light policy, independent of the GPIO that renders it.

/// A visible state of the device, rendered by an optional board status light.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IndicatorState {
    /// The device is waiting for first-time Wi-Fi configuration.
    Setup,
    /// The device is reachable and ready, but no audio is flowing.
    Ready,
    /// The device is sending audio to its bridge.
    Streaming,
    /// A startup failure blocks normal operation.
    Fault,
}

impl IndicatorState {
    /// Stable API name for this state.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Ready => "ready",
            Self::Streaming => "streaming",
            Self::Fault => "fault",
        }
    }

    /// Whether the light is on at `elapsed_ms` within this state's repeating
    /// pattern. Streaming stays lit; the other states repeat every two seconds.
    pub const fn is_lit_at(self, elapsed_ms: u32) -> bool {
        let phase = elapsed_ms % 2_000;
        match self {
            Self::Setup => phase < 400,
            Self::Ready => phase < 150 || (phase >= 300 && phase < 450),
            Self::Streaming => true,
            Self::Fault => {
                phase < 150 || (phase >= 300 && phase < 450) || (phase >= 600 && phase < 750)
            }
        }
    }
}

/// Select the one state an observer needs to distinguish. Fault wins over the
/// normal operating states so a broken audio path cannot look healthy.
pub const fn select(
    is_setup: bool,
    has_blocking_fault: bool,
    is_streaming: bool,
) -> IndicatorState {
    if has_blocking_fault {
        IndicatorState::Fault
    } else if is_setup {
        IndicatorState::Setup
    } else if is_streaming {
        IndicatorState::Streaming
    } else {
        IndicatorState::Ready
    }
}

#[cfg(test)]
mod tests {
    use super::{select, IndicatorState};

    #[test]
    fn fault_has_priority_over_normal_states() {
        assert_eq!(select(true, true, true), IndicatorState::Fault);
    }

    #[test]
    fn selects_setup_before_ready_or_streaming() {
        assert_eq!(select(true, false, true), IndicatorState::Setup);
        assert_eq!(select(false, false, false), IndicatorState::Ready);
        assert_eq!(select(false, false, true), IndicatorState::Streaming);
    }

    #[test]
    fn patterns_are_distinguishable_within_one_cycle() {
        assert!(IndicatorState::Setup.is_lit_at(0));
        assert!(!IndicatorState::Setup.is_lit_at(500));

        assert!(IndicatorState::Ready.is_lit_at(0));
        assert!(!IndicatorState::Ready.is_lit_at(200));
        assert!(IndicatorState::Ready.is_lit_at(300));

        assert!(IndicatorState::Streaming.is_lit_at(1_500));

        assert!(IndicatorState::Fault.is_lit_at(0));
        assert!(!IndicatorState::Fault.is_lit_at(200));
        assert!(IndicatorState::Fault.is_lit_at(300));
        assert!(!IndicatorState::Fault.is_lit_at(500));
        assert!(IndicatorState::Fault.is_lit_at(600));
    }

    #[test]
    fn states_have_stable_api_names() {
        assert_eq!(IndicatorState::Setup.as_str(), "setup");
        assert_eq!(IndicatorState::Ready.as_str(), "ready");
        assert_eq!(IndicatorState::Streaming.as_str(), "streaming");
        assert_eq!(IndicatorState::Fault.as_str(), "fault");
    }
}
