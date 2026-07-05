//! Board descriptors: the user-facing capabilities a firmware build
//! advertises and validates against.
//!
//! Exactly one board is compiled in, selected through [`ACTIVE`]. Supporting
//! another board with a supported codec means adding a descriptor and
//! pointing [`ACTIVE`] at it; a board with a new codec chip also brings its
//! own driver. Consumers read the descriptor and never name a board.

/// Stable id for a codec driver compiled into the firmware.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodecDriverId<'a>(&'a str);

impl CodecDriverId<'static> {
    pub const ES8388: Self = Self("es8388");
}

impl<'a> CodecDriverId<'a> {
    pub const fn new(id: &'a str) -> Self {
        Self(id)
    }

    pub const fn as_str(self) -> &'a str {
        self.0
    }
}

/// Codec hardware mounted on the board.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CodecSpec<'a> {
    pub driver: CodecDriverId<'a>,
    /// 7-bit I2C address the codec answers on.
    pub i2c_address: u8,
}

/// One selectable input, with the label the console shows for it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputOption<'a> {
    pub line: u8,
    pub label: &'a str,
}

/// What a board offers the user. The status API advertises this and the
/// settings API validates against it, so the two cannot diverge.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Board<'a> {
    /// Stable preset id. Custom descriptors use their own namespace.
    pub id: &'a str,
    /// Human-readable board name, advertised in `/api/status`.
    pub name: &'a str,
    /// Codec driver and bus address needed to control line-in capture.
    pub codec: CodecSpec<'a>,
    /// Selectable inputs in console order, never empty; the first entry is
    /// the factory default.
    pub input_lines: &'a [InputOption<'a>],
    /// Upper bound of the input gain control, as a 0..=100 percentage.
    pub input_gain_max: u8,
    /// Upper bound of the ADC attenuation control, in dB.
    pub adc_atten_max_db: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BoardError {
    MissingId,
    MissingName,
    MissingCodecDriver,
    InvalidCodecAddress,
    NoInputLines,
    MissingInputLabel,
    DuplicateInputLine,
    InvalidInputGainMax,
}

impl Board<'_> {
    pub fn validate(&self) -> Result<(), BoardError> {
        if self.id.is_empty() {
            return Err(BoardError::MissingId);
        }
        if self.name.is_empty() {
            return Err(BoardError::MissingName);
        }
        if self.codec.driver.as_str().is_empty() {
            return Err(BoardError::MissingCodecDriver);
        }
        if self.codec.i2c_address > 0x7f {
            return Err(BoardError::InvalidCodecAddress);
        }
        if self.input_lines.is_empty() {
            return Err(BoardError::NoInputLines);
        }
        if self.input_gain_max > 100 {
            return Err(BoardError::InvalidInputGainMax);
        }
        for (i, a) in self.input_lines.iter().enumerate() {
            if a.label.is_empty() {
                return Err(BoardError::MissingInputLabel);
            }
            for b in &self.input_lines[i + 1..] {
                if a.line == b.line {
                    return Err(BoardError::DuplicateInputLine);
                }
            }
        }
        Ok(())
    }

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
pub const ACTIVE: &Board<'static> = &AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388;

/// Built-in board presets compiled into this firmware image.
pub const CATALOG: &[&Board<'static>] = &[&AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388];

/// Ai-Thinker ESP32 Audio Kit v2.2 (ES8388 codec).
pub const AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388: Board<'static> = Board {
    id: "ai-thinker-esp32-audio-kit-v2-2-es8388",
    name: "Ai-Thinker ESP32 Audio Kit v2.2 (ES8388)",
    codec: CodecSpec {
        driver: CodecDriverId::ES8388,
        i2c_address: 0x10,
    },
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
        assert_eq!(ACTIVE.validate(), Ok(()));
        assert!(ACTIVE.accepts_line(ACTIVE.default_line()));
    }

    #[test]
    fn catalog_ids_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in &CATALOG[i + 1..] {
                assert_ne!(a.id, b.id, "board preset ids must be unique");
            }
        }
    }

    #[test]
    fn membership_checks_use_the_advertised_lines() {
        let board = Board {
            id: "test-board",
            name: "test",
            codec: CodecSpec {
                driver: CodecDriverId::ES8388,
                i2c_address: 0x10,
            },
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

    #[test]
    fn validates_descriptor_shape() {
        let duplicate_lines = Board {
            id: "test-board",
            name: "test",
            codec: CodecSpec {
                driver: CodecDriverId::new("es8388"),
                i2c_address: 0x10,
            },
            input_lines: &[
                InputOption {
                    line: 1,
                    label: "one",
                },
                InputOption {
                    line: 1,
                    label: "again",
                },
            ],
            input_gain_max: 100,
            adc_atten_max_db: 48,
        };
        assert_eq!(
            duplicate_lines.validate(),
            Err(BoardError::DuplicateInputLine)
        );

        let invalid_codec_address = Board {
            codec: CodecSpec {
                driver: CodecDriverId::new("es8388"),
                i2c_address: 0x80,
            },
            ..duplicate_lines
        };
        assert_eq!(
            invalid_codec_address.validate(),
            Err(BoardError::InvalidCodecAddress)
        );
    }
}
