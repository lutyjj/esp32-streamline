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
    use super::{next_input_line, ButtonAction, PressDetector, DEBOUNCE_POLLS};
    use crate::board;

    #[test]
    fn actions_have_stable_api_and_storage_names() {
        for (name, action) in [
            ("none", ButtonAction::None),
            ("toggle_stream", ButtonAction::ToggleStream),
            ("cycle_input", ButtonAction::CycleInput),
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
