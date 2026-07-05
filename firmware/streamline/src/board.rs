//! Board descriptors: the user-facing capabilities a firmware build
//! advertises and validates against.
//!
//! Exactly one board is compiled in, selected through [`ACTIVE`]. Supporting
//! another board with a supported codec means adding a descriptor and
//! pointing [`ACTIVE`] at it; a board with a new codec chip also brings its
//! own adapter. Consumers read the descriptor and never name a board.

/// One selectable input, with the label the console shows for it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputOption {
    pub line: u8,
    pub label: &'static str,
}

/// What a board offers the user. The status API advertises this and the
/// settings API validates against it, so the two cannot diverge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Board {
    /// Human-readable board name, advertised in `/api/status`.
    pub name: &'static str,
    /// Selectable inputs in console order, never empty; the first entry is
    /// the factory default.
    pub input_lines: &'static [InputOption],
    /// Upper bound of the input gain control, as a 0..=100 percentage.
    pub input_gain_max: u8,
    /// Upper bound of the ADC attenuation control, in dB.
    pub adc_atten_max_db: u8,
}

impl Board {
    /// Whether `line` is one of this board's selectable inputs.
    pub fn accepts_line(&self, line: u8) -> bool {
        self.input_lines.iter().any(|option| option.line == line)
    }

    /// The input selected when no configuration exists yet.
    pub fn default_line(&self) -> u8 {
        self.input_lines[0].line
    }
}

/// The board this firmware build targets.
pub const ACTIVE: &Board = &ESP32_AUDIO_KIT;

/// Ai-Thinker ESP32 Audio Kit v2.2 (ES8388 codec).
pub const ESP32_AUDIO_KIT: Board = Board {
    name: "ESP32 Audio Kit (ES8388)",
    input_lines: &[
        InputOption {
            line: 2,
            label: "Line 2 — 3.5 mm jack",
        },
        InputOption {
            line: 1,
            label: "Line 1 — header pins",
        },
    ],
    input_gain_max: 100,
    adc_atten_max_db: 48,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_board_is_coherent() {
        assert!(!ACTIVE.input_lines.is_empty());
        assert!(ACTIVE.accepts_line(ACTIVE.default_line()));
        for (i, a) in ACTIVE.input_lines.iter().enumerate() {
            for b in &ACTIVE.input_lines[i + 1..] {
                assert_ne!(a.line, b.line, "advertised lines must be unique");
            }
        }
    }

    #[test]
    fn membership_checks_use_the_advertised_lines() {
        let board = Board {
            name: "test",
            input_lines: &[InputOption {
                line: 7,
                label: "only input",
            }],
            input_gain_max: 10,
            adc_atten_max_db: 6,
        };
        assert!(board.accepts_line(7));
        assert!(!board.accepts_line(1));
        assert_eq!(board.default_line(), 7);
    }
}
