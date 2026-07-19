//! Button action policy: what a press does, independent of the GPIO that
//! carries it.
//!
//! A board advertises the buttons it wires (`crate::board::Button`); the user
//! assigns each one an action. Every action is the press-driven twin of an
//! API capability — `toggle_stream` is `POST /api/stream`, `restart` is
//! `POST /api/restart` — so a button can never do something a client cannot.
//! A new action extends this enum with one variant and one dispatch arm.
//!
//! [`PressDetector`] turns raw polled levels into press events on the host:
//! debounced, edge-triggered, and silent about the boot-time level, so a held
//! or stuck-at-pressed line (QEMU emulates no pull resistors) never fires.

use serde::{Deserialize, Serialize};

use crate::board::Board;

/// The action assigned to a single board button, fired on a simple press.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum ButtonAction {
    /// The press does nothing.
    #[default]
    None,
    /// Pause or resume streaming to the bridge; capture and meters continue.
    ToggleStream,
    /// Select the next advertised input line, wrapping at the end.
    CycleInput,
    /// Raise the input gain one step, up to the board's advertised maximum.
    GainUp,
    /// Lower the input gain one step, down to zero.
    GainDown,
    /// Attenuate the input [`ATTENUATION_STEP_DB`] more (quieter), up to the
    /// board's advertised maximum.
    AttenuationUp,
    /// Attenuate the input [`ATTENUATION_STEP_DB`] less (louder), down to zero.
    AttenuationDown,
    /// Reboot with settings intact.
    Restart,
    /// Erase every setting and reboot into first-time setup.
    FactoryReset,
}

impl ButtonAction {
    /// Stable API and storage name for this action.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ToggleStream => "toggle_stream",
            Self::CycleInput => "cycle_input",
            Self::GainUp => "gain_up",
            Self::GainDown => "gain_down",
            Self::AttenuationUp => "attenuation_up",
            Self::AttenuationDown => "attenuation_down",
            Self::Restart => "restart",
            Self::FactoryReset => "factory_reset",
        }
    }

    /// Decode an action name from the API or storage.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "toggle_stream" => Some(Self::ToggleStream),
            "cycle_input" => Some(Self::CycleInput),
            "gain_up" => Some(Self::GainUp),
            "gain_down" => Some(Self::GainDown),
            "attenuation_up" => Some(Self::AttenuationUp),
            "attenuation_down" => Some(Self::AttenuationDown),
            "restart" => Some(Self::Restart),
            "factory_reset" => Some(Self::FactoryReset),
            _ => None,
        }
    }
}

/// The input line after `current` in the board's advertised order, wrapping at
/// the end. A line the board no longer advertises restarts at the first.
pub fn next_input_line(board: &Board, current: u8) -> u8 {
    let lines = &board.input_lines;
    let position = lines.iter().position(|option| option.line == current);
    match position {
        Some(index) => lines[(index + 1) % lines.len()].line,
        None => lines[0].line,
    }
}

/// Steps a gain button walks across the board's advertised range. Eight steps
/// keep each press audible, and on the official codec's nine-notch 3 dB PGA
/// map every press moves at least one notch instead of dying in quantization.
pub const GAIN_STEPS: u8 = 8;

/// How much one attenuation press changes the ADC attenuation, in dB.
pub const ATTENUATION_STEP_DB: u8 = 3;

/// The input gain one press away from `current`, clamped to the board's range.
pub fn stepped_gain(board: &Board, current: u8, up: bool) -> u8 {
    let step = board.input_gain_max.div_ceil(GAIN_STEPS).max(1);
    step_within(current, step, up, board.input_gain_max)
}

/// The ADC attenuation one press away from `current`, clamped to the board's
/// range. More attenuation is quieter.
pub fn stepped_attenuation(board: &Board, current: u8, up: bool) -> u8 {
    step_within(current, ATTENUATION_STEP_DB, up, board.adc_atten_max_db)
}

fn step_within(current: u8, step: u8, up: bool, max: u8) -> u8 {
    if up {
        current.saturating_add(step).min(max)
    } else {
        current.saturating_sub(step)
    }
}

/// Consecutive identical polls a level must hold before it is believed.
/// At the adapter's poll cadence this absorbs contact bounce without making a
/// deliberate press feel laggy.
pub const DEBOUNCE_POLLS: u8 = 2;

/// Debounced edge detector for one polled button.
///
/// Feed it the pressed level each poll; it reports `true` exactly once per
/// released-to-pressed transition. The first poll seeds the state without
/// firing, so a button held at boot — or a line QEMU holds at a constant
/// level — produces no event until it is released and pressed again.
#[derive(Debug)]
pub struct PressDetector {
    /// The debounced level, `None` until the first poll seeds it.
    stable: Option<bool>,
    /// The level seen last poll and how many consecutive polls it has held.
    candidate: bool,
    held_polls: u8,
}

impl PressDetector {
    pub const fn new() -> Self {
        Self {
            stable: None,
            candidate: false,
            held_polls: 0,
        }
    }

    /// Advance one poll with the current pressed level. Returns `true` when a
    /// debounced released-to-pressed transition completes.
    pub fn update(&mut self, pressed: bool) -> bool {
        if pressed == self.candidate {
            self.held_polls = self.held_polls.saturating_add(1);
        } else {
            self.candidate = pressed;
            self.held_polls = 1;
        }
        if self.held_polls < DEBOUNCE_POLLS {
            return false;
        }
        let previous = self.stable.replace(pressed);
        matches!(previous, Some(false)) && pressed
    }
}

impl Default for PressDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        next_input_line, stepped_attenuation, stepped_gain, ButtonAction, PressDetector,
        ATTENUATION_STEP_DB, DEBOUNCE_POLLS,
    };
    use crate::board;

    #[test]
    fn actions_have_stable_api_and_storage_names() {
        for (name, action) in [
            ("none", ButtonAction::None),
            ("toggle_stream", ButtonAction::ToggleStream),
            ("cycle_input", ButtonAction::CycleInput),
            ("gain_up", ButtonAction::GainUp),
            ("gain_down", ButtonAction::GainDown),
            ("attenuation_up", ButtonAction::AttenuationUp),
            ("attenuation_down", ButtonAction::AttenuationDown),
            ("restart", ButtonAction::Restart),
            ("factory_reset", ButtonAction::FactoryReset),
        ] {
            assert_eq!(action.as_str(), name);
            assert_eq!(ButtonAction::parse(name), Some(action));
            assert_eq!(
                serde_json::to_string(&action).expect("serializable"),
                format!("\"{name}\"")
            );
        }
        assert_eq!(ButtonAction::parse("long_press"), None);
        assert_eq!(ButtonAction::default(), ButtonAction::None);
    }

    #[test]
    fn input_lines_cycle_in_advertised_order_and_wrap() {
        let board = default_board();
        let lines: Vec<u8> = board.input_lines.iter().map(|option| option.line).collect();
        assert!(lines.len() > 1, "the default board advertises two inputs");
        for window in lines.windows(2) {
            assert_eq!(next_input_line(&board, window[0]), window[1]);
        }
        assert_eq!(next_input_line(&board, lines[lines.len() - 1]), lines[0]);
        // A line the board does not advertise restarts at the first.
        assert_eq!(next_input_line(&board, 200), lines[0]);
    }

    #[test]
    fn gain_steps_span_the_range_and_clamp_at_both_ends() {
        let board = default_board();
        // The official board advertises 0..=100: the eight-step walk is 13 per
        // press, past the 12.5 quantization boundary of the codec's nine-notch
        // PGA map, so every press lands on a different notch.
        assert_eq!(stepped_gain(&board, 0, true), 13);
        assert_eq!(stepped_gain(&board, 13, true), 26);
        assert_eq!(stepped_gain(&board, 95, true), 100);
        assert_eq!(stepped_gain(&board, 100, true), 100);
        assert_eq!(stepped_gain(&board, 13, false), 0);
        assert_eq!(stepped_gain(&board, 5, false), 0);
        assert_eq!(stepped_gain(&board, 0, false), 0);

        // A board with a narrower range still walks it in eight steps.
        let mut narrow = default_board();
        narrow.input_gain_max = 20;
        assert_eq!(stepped_gain(&narrow, 0, true), 3);
        assert_eq!(stepped_gain(&narrow, 18, true), 20);
    }

    #[test]
    fn attenuation_steps_in_db_and_clamps_at_both_ends() {
        let board = default_board();
        assert_eq!(stepped_attenuation(&board, 0, true), ATTENUATION_STEP_DB);
        assert_eq!(
            stepped_attenuation(&board, board.adc_atten_max_db - 1, true),
            board.adc_atten_max_db
        );
        assert_eq!(
            stepped_attenuation(&board, board.adc_atten_max_db, true),
            board.adc_atten_max_db
        );
        assert_eq!(
            stepped_attenuation(&board, 9, false),
            9 - ATTENUATION_STEP_DB
        );
        assert_eq!(stepped_attenuation(&board, 1, false), 0);
        assert_eq!(stepped_attenuation(&board, 0, false), 0);
    }

    #[test]
    fn a_debounced_press_fires_exactly_once() {
        let mut detector = PressDetector::new();
        for _ in 0..4 {
            assert!(!detector.update(false));
        }
        assert!(
            !detector.update(true),
            "first pressed poll is not debounced"
        );
        assert!(detector.update(true), "debounced press fires");
        for _ in 0..10 {
            assert!(!detector.update(true), "holding fires nothing further");
        }
    }

    #[test]
    fn release_and_press_again_fires_again() {
        let mut detector = PressDetector::new();
        let mut presses = 0;
        for _ in 0..3 {
            for _ in 0..DEBOUNCE_POLLS + 1 {
                if detector.update(false) {
                    presses += 1;
                }
            }
            for _ in 0..DEBOUNCE_POLLS + 1 {
                if detector.update(true) {
                    presses += 1;
                }
            }
        }
        assert_eq!(presses, 3);
    }

    #[test]
    fn bounce_shorter_than_the_debounce_window_fires_nothing() {
        let mut detector = PressDetector::new();
        for _ in 0..4 {
            detector.update(false);
        }
        // Alternating polls never hold a level for the debounce window.
        for _ in 0..10 {
            assert!(!detector.update(true));
            assert!(!detector.update(false));
        }
    }

    #[test]
    fn a_line_pressed_from_boot_never_fires() {
        // QEMU emulates no pull resistors, so an active-low key can read as
        // pressed forever; a held button at power-on looks the same. Neither
        // may fire an action.
        let mut detector = PressDetector::new();
        for _ in 0..100 {
            assert!(!detector.update(true));
        }
        // Only a real release and press produces an event.
        for _ in 0..DEBOUNCE_POLLS {
            assert!(!detector.update(false));
        }
        assert!(!detector.update(true));
        assert!(detector.update(true));
    }

    fn default_board() -> board::Board {
        let catalog = board::builtin_catalog().expect("valid catalog");
        board::resolve(&catalog, None)
            .expect("default board")
            .clone()
    }
}
