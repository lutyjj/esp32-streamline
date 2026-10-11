//! Board descriptor model.
//!
//! A descriptor is the hardware contract the firmware advertises, validates
//! against, and uses to initialize audio. Built-in descriptors and custom
//! BYOD descriptors use the same JSON shape and validation rules.

use std::fmt;

use streamline_api::board::Board;
use streamline_api::board::BoardError;

pub mod catalog;
pub mod selection;
pub mod update;

pub use catalog::{builtin_catalog, find, resolve, DEFAULT_BOARD_ID};
pub use selection::{select, BoardSelection};
pub use update::{resolve_update, BoardUpdate, BoardUpdateError};

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

#[cfg(test)]
mod tests {
    use super::*;
    use streamline_api::board::{
        Button, CodecSpec, I2cPins, I2sPins, InputOption, Led, PinMap, MAX_BUTTONS,
    };
    use streamline_api::controls::{ButtonAction, LedRole};

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
                "leds":[
                    {"id":"status","label":"Status light","gpio":22,"default_role":"status"},
                    {"id":"aux","label":"Aux","gpio":21}
                ],
                "buttons":[
                    {"id":"key1","label":"Key 1","gpio":36,"active_low":true,"default_action":"toggle_stream"},
                    {"id":"key2","label":"Key 2","gpio":18,"active_low":true}
                ],
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
        assert!(board.has_led("status"));
        assert_eq!(
            board.led("status").map(|led| led.default_role),
            Some(LedRole::Status)
        );
        // An omitted role defaults to Off, so a decorative LED stays dark.
        assert_eq!(
            board.led("aux").map(|led| led.default_role),
            Some(LedRole::Off)
        );
        assert!(!board.has_led("missing"));
        assert!(board.has_button("key1"));
        assert_eq!(
            board.button("key1").map(|button| button.default_action),
            Some(ButtonAction::ToggleStream)
        );
        // An omitted action defaults to None, so a spare button stays inert.
        assert_eq!(
            board.button("key2").map(|button| button.default_action),
            Some(ButtonAction::None)
        );
        assert!(!board.has_button("missing"));
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
            leds: Vec::new(),
            buttons: Vec::new(),
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
            leds: vec![Led {
                id: "status".to_owned(),
                label: "Status light".to_owned(),
                gpio: 14,
                active_low: false,
                default_role: LedRole::Status,
            }],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            duplicate_led_gpio.validate(),
            Err(BoardError::DuplicateGpio)
        );

        let duplicate_led_id = Board {
            leds: vec![
                Led {
                    id: "a".to_owned(),
                    label: "First".to_owned(),
                    gpio: 21,
                    active_low: false,
                    default_role: LedRole::Off,
                },
                Led {
                    id: "a".to_owned(),
                    label: "Second".to_owned(),
                    gpio: 22,
                    active_low: false,
                    default_role: LedRole::Off,
                },
            ],
            ..duplicate_lines.clone()
        };
        assert_eq!(duplicate_led_id.validate(), Err(BoardError::DuplicateLedId));

        let blank_led_label = Board {
            leds: vec![Led {
                id: "status".to_owned(),
                label: String::new(),
                gpio: 21,
                active_low: false,
                default_role: LedRole::Status,
            }],
            ..duplicate_lines.clone()
        };
        assert_eq!(blank_led_label.validate(), Err(BoardError::MissingLedLabel));

        let led_on_input_only_gpio = Board {
            leds: vec![Led {
                id: "status".to_owned(),
                label: "Status light".to_owned(),
                gpio: 34,
                active_low: false,
                default_role: LedRole::Status,
            }],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            led_on_input_only_gpio.validate(),
            Err(BoardError::InvalidOutputGpio)
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
            ..duplicate_lines.clone()
        };
        assert_eq!(
            invalid_output.validate(),
            Err(BoardError::InvalidOutputGpio)
        );

        let button = |id: &str, gpio: u8| Button {
            id: id.to_owned(),
            label: id.to_uppercase(),
            gpio,
            active_low: true,
            default_action: ButtonAction::None,
        };

        // A button may sit on an input-only pin; an LED may not (asserted
        // above), and a non-GPIO number is rejected for both.
        let button_on_input_only_gpio = Board {
            buttons: vec![button("key1", 36)],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            button_on_input_only_gpio.validate(),
            Err(BoardError::DuplicateInputLine),
            "GPIO 36 is a valid button pin; only the line duplication remains"
        );
        let button_on_non_gpio = Board {
            buttons: vec![button("key1", 6)],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            button_on_non_gpio.validate(),
            Err(BoardError::InvalidInputGpio)
        );

        let duplicate_button_gpio = Board {
            buttons: vec![button("key1", 14)],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            duplicate_button_gpio.validate(),
            Err(BoardError::DuplicateGpio)
        );

        let duplicate_button_id = Board {
            buttons: vec![button("key1", 18), button("key1", 19)],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            duplicate_button_id.validate(),
            Err(BoardError::DuplicateButtonId)
        );

        let blank_button_label = Board {
            buttons: vec![Button {
                label: String::new(),
                ..button("key1", 18)
            }],
            ..duplicate_lines.clone()
        };
        assert_eq!(
            blank_button_label.validate(),
            Err(BoardError::MissingButtonLabel)
        );

        let too_many_buttons = Board {
            buttons: (0..MAX_BUTTONS as u8 + 1)
                .map(|i| button(&format!("key{i}"), 18))
                .collect(),
            ..duplicate_lines
        };
        assert_eq!(too_many_buttons.validate(), Err(BoardError::TooManyButtons));
    }
}
