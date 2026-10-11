//! Audio values constrained by a board descriptor.

use crate::board::Board;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioSettings {
    /// Selected input, one of the resolved board's advertised lines.
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
}

impl AudioSettings {
    pub fn validate(self, board: &Board) -> Result<Self, AudioSettingsError> {
        if !board.accepts_line(self.input_line) {
            return Err(AudioSettingsError::InvalidInputLine);
        }
        if self.input_gain > board.input_gain_max {
            return Err(AudioSettingsError::InvalidInputGain);
        }
        if self.adc_attenuation_db > board.adc_atten_max_db {
            return Err(AudioSettingsError::InvalidAdcAttenuation);
        }
        Ok(self)
    }

    pub fn compatible_with(self, board: &Board) -> Self {
        Self {
            input_line: if board.accepts_line(self.input_line) {
                self.input_line
            } else {
                board.default_line()
            },
            input_gain: self.input_gain.min(board.input_gain_max),
            adc_attenuation_db: self.adc_attenuation_db.min(board.adc_atten_max_db),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioSettingsError {
    InvalidInputLine,
    InvalidInputGain,
    InvalidAdcAttenuation,
}
