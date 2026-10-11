//! Board descriptor values and structural validation.

use crate::controls::{ButtonAction, LedRole};
use serde::{Deserialize, Serialize};

/// Largest custom descriptor accepted by the API and persistent store.
pub const MAX_DESCRIPTOR_BYTES: usize = 3_072;

/// Most LEDs a single board descriptor may advertise. Bounds the descriptor and
/// the per-LED role map that rides in the persisted configuration record.
pub const MAX_LEDS: usize = 8;

/// Most buttons a single board descriptor may advertise. Bounds the descriptor
/// and the per-button action map that rides in the persisted configuration
/// record.
pub const MAX_BUTTONS: usize = 8;

/// Codec hardware mounted on the board.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CodecSpec {
    pub driver: String,
    /// 7-bit I2C address the codec answers on.
    pub i2c_address: u8,
}

/// ESP32 GPIO wiring used by the board's audio hardware.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct PinMap {
    pub i2c: I2cPins,
    pub i2s: I2sPins,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct I2cPins {
    pub sda: u8,
    pub scl: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct I2sPins {
    pub mclk: u8,
    pub bclk: u8,
    pub ws: u8,
    pub din: u8,
}

/// One board LED wired to an ESP32 output GPIO, with the role it takes until
/// the user assigns another.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct Led {
    /// Stable id, unique within the board, used to address the LED in settings.
    pub id: String,
    /// Human-readable name the console shows for this LED.
    pub label: String,
    pub gpio: u8,
    /// `true` when driving the GPIO low lights the LED.
    #[serde(default)]
    pub active_low: bool,
    /// Role applied until the user assigns another, so a board author can wire a
    /// status light while leaving decorative LEDs dark.
    #[serde(default)]
    pub default_role: LedRole,
}

/// One board button wired to an ESP32 input GPIO, with the action it fires
/// until the user assigns another.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct Button {
    /// Stable id, unique within the board, used to address the button in
    /// settings.
    pub id: String,
    /// Human-readable name the console shows for this button.
    pub label: String,
    pub gpio: u8,
    /// `true` when the GPIO reads low while the button is held. The firmware
    /// enables the matching internal pull where the pin has one; input-only
    /// pins (GPIO 34–39) rely on the board's own resistor.
    #[serde(default)]
    pub active_low: bool,
    /// Action fired until the user assigns another, so a board author can ship
    /// useful presses while leaving spare buttons inert.
    #[serde(default)]
    pub default_action: ButtonAction,
}

/// One selectable input, with the label the console shows for it.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct InputOption {
    pub line: u8,
    pub label: String,
}

/// One board-wired local analog output that the selected codec can route from
/// every advertised input.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AnalogPassthroughCapability {
    pub output_line: u8,
    pub label: String,
}

/// What a board offers the user. The status API advertises this and the
/// settings API validates against it, so the two cannot diverge.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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
    /// Board LEDs the user can assign roles to, in console order. Empty when the
    /// board wires none.
    #[serde(default)]
    pub leds: Vec<Led>,
    /// Board buttons the user can assign actions to, in console order. Empty
    /// when the board wires none.
    #[serde(default)]
    pub buttons: Vec<Button>,
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
    TooManyLeds,
    MissingLedId,
    MissingLedLabel,
    DuplicateLedId,
    TooManyButtons,
    MissingButtonId,
    MissingButtonLabel,
    DuplicateButtonId,
}

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
        if self.leds.len() > MAX_LEDS {
            return Err(BoardError::TooManyLeds);
        }
        for (i, led) in self.leds.iter().enumerate() {
            if led.id.is_empty() {
                return Err(BoardError::MissingLedId);
            }
            if led.label.is_empty() {
                return Err(BoardError::MissingLedLabel);
            }
            validate_output_gpio(led.gpio)?;
            if self.leds[i + 1..].iter().any(|other| other.id == led.id) {
                return Err(BoardError::DuplicateLedId);
            }
        }
        if self.buttons.len() > MAX_BUTTONS {
            return Err(BoardError::TooManyButtons);
        }
        for (i, button) in self.buttons.iter().enumerate() {
            if button.id.is_empty() {
                return Err(BoardError::MissingButtonId);
            }
            if button.label.is_empty() {
                return Err(BoardError::MissingButtonLabel);
            }
            validate_input_gpio(button.gpio)?;
            if self.buttons[i + 1..]
                .iter()
                .any(|other| other.id == button.id)
            {
                return Err(BoardError::DuplicateButtonId);
            }
        }
        let gpios = self.gpios();
        for (i, a) in gpios.iter().enumerate() {
            if gpios[i + 1..].contains(a) {
                return Err(BoardError::DuplicateGpio);
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

    /// The board LED with this id, if the descriptor advertises one.
    pub fn led(&self, id: &str) -> Option<&Led> {
        self.leds.iter().find(|led| led.id == id)
    }

    /// Whether `id` names one of this board's LEDs.
    pub fn has_led(&self, id: &str) -> bool {
        self.led(id).is_some()
    }

    /// The board button with this id, if the descriptor advertises one.
    pub fn button(&self, id: &str) -> Option<&Button> {
        self.buttons.iter().find(|button| button.id == id)
    }

    /// Whether `id` names one of this board's buttons.
    pub fn has_button(&self, id: &str) -> bool {
        self.button(id).is_some()
    }

    /// Every GPIO the descriptor claims: the six audio pins plus each LED and
    /// button.
    fn gpios(&self) -> Vec<u8> {
        let mut gpios = vec![
            self.pins.i2c.sda,
            self.pins.i2c.scl,
            self.pins.i2s.mclk,
            self.pins.i2s.bclk,
            self.pins.i2s.ws,
            self.pins.i2s.din,
        ];
        gpios.extend(self.leds.iter().map(|led| led.gpio));
        gpios.extend(self.buttons.iter().map(|button| button.gpio));
        gpios
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

/// Whether this GPIO has an output-capable pad. The same pads carry the
/// ESP32's internal pull resistors, so this also tells an input user whether
/// an internal pull is available; GPIO 34–39 are input-only and have none.
pub const fn is_output_gpio(gpio: u8) -> bool {
    matches!(gpio, 0..=5 | 12..=23 | 25..=33)
}

const fn is_gpio(gpio: u8) -> bool {
    matches!(gpio, 0..=5 | 12..=23 | 25..=39)
}
