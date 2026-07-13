//! Desired and observed state for a codec's local analog output route.

use std::fmt;

use crate::config::AudioSettings;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AnalogPassthroughRoute {
    pub input_line: u8,
    pub output_line: u8,
}

/// Hardware boundary owned by the passthrough policy, implemented by a codec
/// adapter at the edge of the application.
pub trait AnalogPassthroughControl {
    type Error: fmt::Display;

    fn enable(&mut self, route: AnalogPassthroughRoute) -> Result<(), Self::Error>;
    fn disable(&mut self) -> Result<(), Self::Error>;
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AnalogPassthroughState {
    pub active: bool,
    pub fault: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AnalogPassthroughError {
    Unsupported,
    Control(String),
}

impl fmt::Display for AnalogPassthroughError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => write!(f, "local analog output is not supported by this board"),
            Self::Control(error) => write!(f, "local analog output control failed: {error}"),
        }
    }
}

impl std::error::Error for AnalogPassthroughError {}

impl AnalogPassthroughState {
    /// Reconcile persisted intent with the live codec. A failed enable always
    /// attempts to disable the route before exposing the fault.
    pub fn reconcile<C>(
        &mut self,
        enabled: bool,
        route: Option<AnalogPassthroughRoute>,
        control: &mut C,
    ) -> Result<(), AnalogPassthroughError>
    where
        C: AnalogPassthroughControl,
    {
        if enabled {
            let route = route.ok_or(AnalogPassthroughError::Unsupported)?;
            if self.active {
                return Ok(());
            }
            return match control.enable(route) {
                Ok(()) => {
                    self.active = true;
                    self.fault = None;
                    Ok(())
                }
                Err(error) => {
                    let mut message = error.to_string();
                    if let Err(disable_error) = control.disable() {
                        message.push_str("; fail-close failed: ");
                        message.push_str(&disable_error.to_string());
                    }
                    self.record_fault(message.clone());
                    Err(AnalogPassthroughError::Control(message))
                }
            };
        }

        if let Err(error) = control.disable() {
            let message = error.to_string();
            self.record_fault(message.clone());
            return Err(AnalogPassthroughError::Control(message));
        }
        self.active = false;
        self.fault = None;
        Ok(())
    }

    pub fn record_fault(&mut self, error: impl Into<String>) {
        self.active = false;
        self.fault = Some(error.into());
    }
}

/// An active route only needs re-selecting when the capture input changes.
/// Input gain and ADC attenuation remain capture-only controls.
pub fn route_for_audio_change(
    active: bool,
    previous: AudioSettings,
    next: AudioSettings,
    output_line: u8,
) -> Option<AnalogPassthroughRoute> {
    (active && previous.input_line != next.input_line).then_some(AnalogPassthroughRoute {
        input_line: next.input_line,
        output_line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeControl {
        enable_error: Option<&'static str>,
        disable_error: Option<&'static str>,
        enabled: Vec<AnalogPassthroughRoute>,
        disable_calls: usize,
    }

    impl AnalogPassthroughControl for FakeControl {
        type Error = &'static str;

        fn enable(&mut self, route: AnalogPassthroughRoute) -> Result<(), Self::Error> {
            self.enabled.push(route);
            self.enable_error.map_or(Ok(()), Err)
        }

        fn disable(&mut self) -> Result<(), Self::Error> {
            self.disable_calls += 1;
            self.disable_error.map_or(Ok(()), Err)
        }
    }

    const ROUTE: AnalogPassthroughRoute = AnalogPassthroughRoute {
        input_line: 2,
        output_line: 2,
    };

    #[test]
    fn reconciles_desired_and_active_state() {
        let mut state = AnalogPassthroughState::default();
        let mut control = FakeControl::default();

        assert_eq!(state.reconcile(true, Some(ROUTE), &mut control), Ok(()));
        assert!(state.active);
        assert_eq!(control.enabled, vec![ROUTE]);

        assert_eq!(state.reconcile(false, Some(ROUTE), &mut control), Ok(()));
        assert_eq!(state, AnalogPassthroughState::default());
        assert_eq!(control.disable_calls, 1);
    }

    #[test]
    fn rejects_an_unadvertised_route_without_touching_hardware() {
        let mut state = AnalogPassthroughState::default();
        let mut control = FakeControl::default();

        assert_eq!(
            state.reconcile(true, None, &mut control),
            Err(AnalogPassthroughError::Unsupported)
        );
        assert!(control.enabled.is_empty());
        assert_eq!(control.disable_calls, 0);
    }

    #[test]
    fn explicit_off_retries_the_fail_close_even_when_not_active() {
        let mut state = AnalogPassthroughState {
            active: false,
            fault: Some("earlier failure".to_owned()),
        };
        let mut control = FakeControl::default();

        assert_eq!(state.reconcile(false, Some(ROUTE), &mut control), Ok(()));
        assert_eq!(state, AnalogPassthroughState::default());
        assert_eq!(control.disable_calls, 1);
    }

    #[test]
    fn failed_enable_is_inactive_and_fail_closed() {
        let mut state = AnalogPassthroughState::default();
        let mut control = FakeControl {
            enable_error: Some("write failed"),
            ..FakeControl::default()
        };

        assert!(matches!(
            state.reconcile(true, Some(ROUTE), &mut control),
            Err(AnalogPassthroughError::Control(_))
        ));
        assert!(!state.active);
        assert_eq!(state.fault.as_deref(), Some("write failed"));
        assert_eq!(control.disable_calls, 1);
    }

    #[test]
    fn fail_close_error_is_preserved_in_the_observed_fault() {
        let mut state = AnalogPassthroughState::default();
        let mut control = FakeControl {
            enable_error: Some("write failed"),
            disable_error: Some("mute failed"),
            ..FakeControl::default()
        };

        assert!(state.reconcile(true, Some(ROUTE), &mut control).is_err());
        assert_eq!(
            state.fault.as_deref(),
            Some("write failed; fail-close failed: mute failed")
        );
    }

    #[test]
    fn input_switch_changes_the_route_but_capture_levels_do_not() {
        let audio = AudioSettings {
            input_line: 2,
            input_gain: 0,
            adc_attenuation_db: 11,
        };
        let levels = AudioSettings {
            input_gain: 80,
            adc_attenuation_db: 30,
            ..audio
        };
        assert_eq!(route_for_audio_change(true, audio, levels, 2), None);
        assert_eq!(
            route_for_audio_change(
                true,
                audio,
                AudioSettings {
                    input_line: 1,
                    ..audio
                },
                2
            ),
            Some(AnalogPassthroughRoute {
                input_line: 1,
                output_line: 2,
            })
        );
        assert_eq!(
            route_for_audio_change(
                false,
                audio,
                AudioSettings {
                    input_line: 1,
                    ..audio
                },
                2
            ),
            None
        );
    }
}
