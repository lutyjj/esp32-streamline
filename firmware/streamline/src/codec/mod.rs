//! Codec-owned board capability contracts.
//!
//! Board descriptors own GPIO shape and user-facing labels. Each codec driver
//! owns the lines, ranges, and control-bus addresses it can actually apply.

use crate::board::Board;

mod control;
mod es8388;

pub use control::{AudioChangeError, CodecControl};

/// Device control I/O; settling delays remain ordered with register writes.
pub trait RegisterBus {
    fn write(&mut self, register: u8, value: u8) -> anyhow::Result<()>;
    fn delay_ms(&mut self, millis: u32);
}

pub const ES8388_DRIVER: &str = "es8388";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodecError {
    UnsupportedDriver,
    UnsupportedAddress,
    UnsupportedInputLine,
    UnsupportedInputGain,
    UnsupportedAdcAttenuation,
    UnsupportedAnalogPassthroughRoute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Driver {
    Es8388,
}

impl Driver {
    pub fn resolve(id: &str) -> Result<Self, CodecError> {
        match id {
            ES8388_DRIVER => Ok(Self::Es8388),
            _ => Err(CodecError::UnsupportedDriver),
        }
    }

    pub fn validate_board(self, board: &Board) -> Result<(), CodecError> {
        match self {
            Self::Es8388 => es8388::validate_board(board),
        }
    }
}

/// Validate the capabilities advertised by a descriptor against its selected
/// driver. The caller has already applied the descriptor's generic shape and
/// GPIO checks.
pub fn validate_board(board: &Board) -> Result<(), CodecError> {
    Driver::resolve(&board.codec.driver)?.validate_board(board)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board;

    fn board() -> Board {
        board::builtin_catalog().expect("catalog").remove(0)
    }

    #[test]
    fn es8388_accepts_its_explicit_capabilities() {
        assert_eq!(validate_board(&board()), Ok(()));
    }

    #[test]
    fn es8388_rejects_unsupported_descriptor_capabilities() {
        let mut candidate = board();
        candidate.input_lines[0].line = 3;
        assert_eq!(
            validate_board(&candidate),
            Err(CodecError::UnsupportedInputLine)
        );

        let mut candidate = board();
        candidate.input_gain_max = 101;
        assert_eq!(
            validate_board(&candidate),
            Err(CodecError::UnsupportedInputGain)
        );

        let mut candidate = board();
        candidate.adc_atten_max_db = 49;
        assert_eq!(
            validate_board(&candidate),
            Err(CodecError::UnsupportedAdcAttenuation)
        );

        let mut candidate = board();
        candidate.codec.i2c_address = 0x11;
        assert_eq!(
            validate_board(&candidate),
            Err(CodecError::UnsupportedAddress)
        );

        let mut candidate = board();
        candidate
            .analog_passthrough
            .as_mut()
            .expect("official route")
            .output_line = 3;
        assert_eq!(
            validate_board(&candidate),
            Err(CodecError::UnsupportedAnalogPassthroughRoute)
        );
    }
}

#[cfg(test)]
mod transaction_tests;
