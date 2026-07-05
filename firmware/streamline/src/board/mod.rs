//! Board descriptor model.
//!
//! A descriptor is the hardware contract the firmware advertises, validates
//! against, and uses to initialize audio. Official preset data lives in
//! [`presets`]; generic consumers read a resolved [`Board`] value.

pub mod presets;

pub use presets::{find_preset, resolve_preset, CATALOG, DEFAULT_PRESET};

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

/// ESP32 GPIO wiring used by the board's audio hardware.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PinMap {
    pub i2c: I2cPins,
    pub i2s: I2sPins,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct I2cPins {
    pub sda: u8,
    pub scl: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct I2sPins {
    pub mclk: u8,
    pub bclk: u8,
    pub ws: u8,
    pub din: u8,
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
    /// Stable descriptor id. Official presets and custom boards share this
    /// identity shape.
    pub id: &'a str,
    /// Human-readable board name, advertised in `/api/status`.
    pub name: &'a str,
    /// Codec driver and bus address needed to control line-in capture.
    pub codec: CodecSpec<'a>,
    /// ESP32 GPIO wiring for codec control and I2S capture.
    pub pins: PinMap,
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
    InvalidOutputGpio,
    InvalidInputGpio,
    DuplicateGpio,
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
        validate_output_gpio(self.pins.i2c.sda)?;
        validate_output_gpio(self.pins.i2c.scl)?;
        validate_output_gpio(self.pins.i2s.mclk)?;
        validate_output_gpio(self.pins.i2s.bclk)?;
        validate_output_gpio(self.pins.i2s.ws)?;
        validate_input_gpio(self.pins.i2s.din)?;
        for (i, a) in self.gpios().iter().enumerate() {
            for b in &self.gpios()[i + 1..] {
                if a == b {
                    return Err(BoardError::DuplicateGpio);
                }
            }
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

    fn gpios(&self) -> [u8; 6] {
        [
            self.pins.i2c.sda,
            self.pins.i2c.scl,
            self.pins.i2s.mclk,
            self.pins.i2s.bclk,
            self.pins.i2s.ws,
            self.pins.i2s.din,
        ]
    }
}

fn validate_output_gpio(gpio: u8) -> Result<(), BoardError> {
    if is_output_gpio(gpio) {
        Ok(())
    } else {
        Err(BoardError::InvalidOutputGpio)
    }
}

fn validate_input_gpio(gpio: u8) -> Result<(), BoardError> {
    if is_gpio(gpio) {
        Ok(())
    } else {
        Err(BoardError::InvalidInputGpio)
    }
}

const fn is_output_gpio(gpio: u8) -> bool {
    matches!(gpio, 0..=5 | 12..=23 | 25..=33)
}

const fn is_gpio(gpio: u8) -> bool {
    matches!(gpio, 0..=5 | 12..=23 | 25..=39)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn membership_checks_use_the_advertised_lines() {
        let board = Board {
            id: "test-board",
            name: "test",
            codec: CodecSpec {
                driver: CodecDriverId::ES8388,
                i2c_address: 0x10,
            },
            pins: PinMap {
                i2c: I2cPins { sda: 4, scl: 5 },
                i2s: I2sPins {
                    mclk: 12,
                    bclk: 13,
                    ws: 14,
                    din: 35,
                },
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
            pins: PinMap {
                i2c: I2cPins { sda: 4, scl: 5 },
                i2s: I2sPins {
                    mclk: 12,
                    bclk: 13,
                    ws: 14,
                    din: 35,
                },
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

        let duplicate_gpios = Board {
            pins: PinMap {
                i2c: I2cPins { sda: 4, scl: 5 },
                i2s: I2sPins {
                    mclk: 12,
                    bclk: 13,
                    ws: 14,
                    din: 14,
                },
            },
            ..duplicate_lines
        };
        assert_eq!(duplicate_gpios.validate(), Err(BoardError::DuplicateGpio));

        let invalid_output = Board {
            pins: PinMap {
                i2c: I2cPins { sda: 35, scl: 5 },
                i2s: I2sPins {
                    mclk: 12,
                    bclk: 13,
                    ws: 14,
                    din: 34,
                },
            },
            ..duplicate_lines
        };
        assert_eq!(
            invalid_output.validate(),
            Err(BoardError::InvalidOutputGpio)
        );
    }
}
