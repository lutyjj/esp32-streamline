//! Board descriptor model.
//!
//! A descriptor is the hardware contract the firmware advertises, validates
//! against, and uses to initialize audio. Built-in descriptors and custom
//! BYOD descriptors use the same JSON shape and validation rules.

use std::fmt;

use serde::{Deserialize, Serialize};

pub mod catalog;
pub mod selection;
pub mod update;

pub use catalog::{builtin_catalog, find, resolve, DEFAULT_BOARD_ID};
pub use selection::{select, BoardSelection};
pub use update::{resolve_update, BoardUpdate, BoardUpdateError};

/// Largest custom descriptor accepted by the API and persistent store.
pub const MAX_DESCRIPTOR_BYTES: usize = 3_072;

/// Codec hardware mounted on the board.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CodecSpec {
    pub driver: String,
    /// 7-bit I2C address the codec answers on.
    pub i2c_address: u8,
}

/// ESP32 GPIO wiring used by the board's audio hardware.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct PinMap {
    pub i2c: I2cPins,
    pub i2s: I2sPins,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct I2cPins {
    pub sda: u8,
    pub scl: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct I2sPins {
    pub mclk: u8,
    pub bclk: u8,
    pub ws: u8,
    pub din: u8,
}

/// Optional single-color status light wired to an ESP32 output GPIO.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct StatusLed {
    pub gpio: u8,
    /// `true` when driving the GPIO low lights the LED.
    #[serde(default)]
    pub active_low: bool,
}

/// One selectable input, with the label the console shows for it.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct InputOption {
    pub line: u8,
    pub label: String,
}

/// One board-wired local analog output that the selected codec can route from
/// every advertised input.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AnalogPassthroughCapability {
    pub output_line: u8,
    pub label: String,
}

/// What a board offers the user. The status API advertises this and the
/// settings API validates against it, so the two cannot diverge.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct Board {
    /// Stable descriptor id. Official presets and custom boards share this
    /// identity shape.
    pub id: String,
    /// Human-readable board name, advertised in `/api/status`.
    pub name: String,
    /// Codec driver and bus address needed to control line-in capture.
    pub codec: CodecSpec,
    /// ESP32 GPIO wiring for codec control and I2S capture.
    pub pins: PinMap,
    /// A board-owned light that renders the device's status, when present.
    #[serde(default)]
    pub status_led: Option<StatusLed>,
    /// Local analog monitoring output, absent when the board has no supported
    /// route.
    #[serde(default)]
    pub analog_passthrough: Option<AnalogPassthroughCapability>,
    /// Selectable inputs in console order, never empty; the first entry is
    /// the factory default.
    pub input_lines: Vec<InputOption>,
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
    MissingAnalogPassthroughLabel,
    DuplicateInputLine,
    InvalidInputGainMax,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BoardLoadError {
    Json(String),
    Invalid {
        id: String,
        error: BoardError,
    },
    UnsupportedCodec {
        id: String,
        error: crate::codec::CodecError,
    },
    DuplicateId(String),
    MissingDefault(String),
}

impl fmt::Display for BoardLoadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(error) => write!(f, "invalid board descriptor JSON: {error}"),
            Self::Invalid { id, error } => write!(f, "invalid board descriptor '{id}': {error:?}"),
            Self::UnsupportedCodec { id, error } => {
                write!(
                    f,
                    "board descriptor '{id}' exceeds its codec capabilities: {error:?}"
                )
            }
            Self::DuplicateId(id) => write!(f, "duplicate board descriptor id '{id}'"),
            Self::MissingDefault(id) => write!(f, "default board descriptor '{id}' is missing"),
        }
    }
}

impl std::error::Error for BoardLoadError {}

impl Board {
    pub fn validate(&self) -> Result<(), BoardError> {
        if self.id.is_empty() {
            return Err(BoardError::MissingId);
        }
        if self.name.is_empty() {
            return Err(BoardError::MissingName);
        }
        if self.codec.driver.is_empty() {
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
        if let Some(led) = self.status_led {
            validate_output_gpio(led.gpio)?;
            if self.gpios().contains(&led.gpio) {
                return Err(BoardError::DuplicateGpio);
            }
        }
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
        if self
            .analog_passthrough
            .as_ref()
            .is_some_and(|capability| capability.label.is_empty())
        {
            return Err(BoardError::MissingAnalogPassthroughLabel);
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

pub fn parse_descriptor(json: &str) -> Result<Board, BoardLoadError> {
    let board: Board =
        serde_json::from_str(json).map_err(|error| BoardLoadError::Json(error.to_string()))?;
    validate_descriptor(board)
}

pub fn validate_descriptor(board: Board) -> Result<Board, BoardLoadError> {
    validate_board(&board)?;
    Ok(board)
}

pub fn validate_catalog(catalog: &[Board]) -> Result<(), BoardLoadError> {
    for board in catalog {
        validate_board(board)?;
    }
    for (i, a) in catalog.iter().enumerate() {
        for b in &catalog[i + 1..] {
            if a.id == b.id {
                return Err(BoardLoadError::DuplicateId(a.id.clone()));
            }
        }
    }
    Ok(())
}

fn validate_board(board: &Board) -> Result<(), BoardLoadError> {
    board.validate().map_err(|error| BoardLoadError::Invalid {
        id: board.id.clone(),
        error,
    })?;
    crate::codec::validate_board(board).map_err(|error| BoardLoadError::UnsupportedCodec {
        id: board.id.clone(),
        error,
    })
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
    fn parses_json_descriptors() {
        let board = parse_descriptor(
            r#"{
                "id":"test-board",
                "name":"test",
                "codec":{"driver":"es8388","i2c_address":16},
                "pins":{
                    "i2c":{"sda":4,"scl":5},
                    "i2s":{"mclk":12,"bclk":13,"ws":14,"din":35}
                },
                "status_led":{"gpio":22},
                "input_lines":[{"line":2,"label":"only input"}],
                "input_gain_max":10,
                "adc_atten_max_db":6
            }"#,
        )
        .expect("valid descriptor");

        assert!(board.accepts_line(2));
        assert!(!board.accepts_line(1));
        assert_eq!(board.default_line(), 2);
        assert_eq!(board.analog_passthrough, None);
    }

    #[test]
    fn rejects_unknown_json_fields() {
        assert!(matches!(
            parse_descriptor(
                r#"{
                    "id":"test-board",
                    "name":"test",
                    "codec":{"driver":"es8388","i2c_address":16},
                    "pins":{
                        "i2c":{"sda":4,"scl":5},
                        "i2s":{"mclk":12,"bclk":13,"ws":14,"din":35}
                    },
                    "input_lines":[{"line":7,"label":"only input"}],
                    "input_gain_max":10,
                    "adc_atten_max_db":6,
                    "surprise":true
                }"#,
            ),
            Err(BoardLoadError::Json(_))
        ));
    }

    #[test]
    fn rejects_descriptor_capabilities_the_codec_cannot_apply() {
        let invalid = parse_descriptor(
            r#"{
                "id":"test-board",
                "name":"test",
                "codec":{"driver":"es8388","i2c_address":16},
                "pins":{
                    "i2c":{"sda":4,"scl":5},
                    "i2s":{"mclk":12,"bclk":13,"ws":14,"din":35}
                },
                "input_lines":[{"line":3,"label":"unsupported"}],
                "input_gain_max":100,
                "adc_atten_max_db":48
            }"#,
        );

        assert!(matches!(
            invalid,
            Err(BoardLoadError::UnsupportedCodec {
                error: crate::codec::CodecError::UnsupportedInputLine,
                ..
            })
        ));
    }

    #[test]
    fn validates_descriptor_shape() {
        let duplicate_lines = Board {
            id: "test-board".to_owned(),
            name: "test".to_owned(),
            codec: CodecSpec {
                driver: "es8388".to_owned(),
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
            status_led: None,
            analog_passthrough: None,
            input_lines: vec![
                InputOption {
                    line: 1,
                    label: "one".to_owned(),
                },
                InputOption {
                    line: 1,
                    label: "again".to_owned(),
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
                driver: "es8388".to_owned(),
                i2c_address: 0x80,
            },
            ..duplicate_lines.clone()
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
            ..duplicate_lines.clone()
        };
        assert_eq!(duplicate_gpios.validate(), Err(BoardError::DuplicateGpio));

        let duplicate_led_gpio = Board {
            status_led: Some(StatusLed {
                gpio: 14,
                active_low: false,
            }),
            ..duplicate_lines.clone()
        };
        assert_eq!(
            duplicate_led_gpio.validate(),
            Err(BoardError::DuplicateGpio)
        );

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
