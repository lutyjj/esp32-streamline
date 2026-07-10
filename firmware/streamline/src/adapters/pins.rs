//! Descriptor GPIO numbers as erased ESP-IDF HAL pins.
//!
//! Board presets and custom board definitions store GPIO numbers as data. The
//! HAL's I2C and I2S drivers accept erased `Any*Pin` values, so this adapter is
//! the only place that turns validated descriptor data into HAL pin tokens.

use esp_idf_svc::hal::gpio::{AnyIOPin, AnyInputPin};

use crate::board::PinMap;

pub struct AudioPins<'d> {
    pub i2c: I2cBusPins<'d>,
    pub i2s: I2sBusPins<'d>,
}

pub struct I2cBusPins<'d> {
    pub sda: AnyIOPin<'d>,
    pub scl: AnyIOPin<'d>,
}

pub struct I2sBusPins<'d> {
    pub mclk: AnyIOPin<'d>,
    pub bclk: AnyIOPin<'d>,
    pub ws: AnyIOPin<'d>,
    pub din: AnyInputPin<'d>,
}

impl AudioPins<'static> {
    pub fn new(map: PinMap) -> Self {
        Self {
            i2c: I2cBusPins {
                sda: output_pin(map.i2c.sda),
                scl: output_pin(map.i2c.scl),
            },
            i2s: I2sBusPins {
                mclk: output_pin(map.i2s.mclk),
                bclk: output_pin(map.i2s.bclk),
                ws: output_pin(map.i2s.ws),
                din: any_input_pin(map.i2s.din),
            },
        }
    }
}

/// Turn a validated descriptor GPIO into an erased output-capable HAL pin.
pub fn output_pin(gpio: u8) -> AnyIOPin<'static> {
    // Safety: board descriptors are validated before boot wiring reaches this
    // adapter, and `main` does not retain the generated `Pins` token. No
    // second HAL pin instance is kept or used.
    unsafe { AnyIOPin::steal(gpio) }
}

fn any_input_pin(gpio: u8) -> AnyInputPin<'static> {
    // Safety: see `any_io_pin`.
    unsafe { AnyInputPin::steal(gpio) }
}
