//! Minimal audio codec configuration.
//!
//! This is deliberately not a port of the Arduino audio-driver abstraction.
//! The register sequence is the small, auditable subset required for ES8388
//! line-in capture: I2S slave mode, 48 kHz/16-bit stereo, an ADC input selected
//! by the board descriptor, and no DAC output.
//!
//! A board descriptor selects a codec driver by stable id. New codec chips add
//! one implementation plus one resolver entry; capture and transport never name
//! a codec.

use anyhow::{anyhow, Result};
use esp_idf_svc::hal::{
    delay::BLOCK,
    i2c::{I2cConfig, I2cDriver, I2C0},
    units::Hertz,
};

use crate::{
    adapters::pins::I2cBusPins,
    board::{CodecDriverId, CodecSpec},
    config::AudioSettings,
};

/// A line-in capture codec on the shared I2C control bus.
trait CodecDriver {
    /// Apply the capture configuration over an already-open I2C bus: I2S slave
    /// at 48 kHz/16-bit stereo, with the selected input line, gain, and ADC
    /// attenuation.
    fn configure(bus: &mut I2cDriver<'_>, address: u8, audio: AudioSettings) -> Result<()>;

    /// Rewrite only the input controls — line, gain, attenuation — on a codec
    /// that is already running, without a reset or capture interruption.
    fn apply(bus: &mut I2cDriver<'_>, address: u8, audio: AudioSettings) -> Result<()>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Driver {
    Es8388,
}

impl Driver {
    fn resolve(id: CodecDriverId<'_>) -> Result<Self> {
        if id == CodecDriverId::ES8388 {
            Ok(Self::Es8388)
        } else {
            Err(anyhow!("unsupported codec driver '{}'", id.as_str()))
        }
    }

    fn configure(self, bus: &mut I2cDriver<'_>, address: u8, audio: AudioSettings) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::configure(bus, address, audio),
        }
    }

    fn apply(self, bus: &mut I2cDriver<'_>, address: u8, audio: AudioSettings) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::apply(bus, address, audio),
        }
    }
}

/// Open the control bus, configure the board's codec, and return a handle that
/// can re-apply input settings while the device streams.
pub fn configure<'d>(
    i2c: I2C0<'d>,
    pins: I2cBusPins<'d>,
    codec: CodecSpec<'_>,
    audio: AudioSettings,
) -> Result<CodecControl<'d>> {
    let driver = Driver::resolve(codec.driver)?;
    let config = I2cConfig::new()
        .baudrate(Hertz(100_000))
        .sda_enable_pullup(true)
        .scl_enable_pullup(true);
    let mut bus = I2cDriver::new(i2c, pins.sda, pins.scl, &config)?;
    driver.configure(&mut bus, codec.i2c_address, audio)?;
    Ok(CodecControl {
        bus,
        driver,
        i2c_address: codec.i2c_address,
    })
}

/// Owns the codec's I2C control bus after boot so input settings can change
/// without rebooting the device.
pub struct CodecControl<'d> {
    bus: I2cDriver<'d>,
    driver: Driver,
    i2c_address: u8,
}

impl CodecControl<'_> {
    /// Apply new input settings to the running codec.
    pub fn apply(&mut self, audio: AudioSettings) -> Result<()> {
        self.driver.apply(&mut self.bus, self.i2c_address, audio)
    }
}

/// ES8388 ADC codec.
struct Es8388;

const CONTROL1: u8 = 0x00;
const CONTROL2: u8 = 0x01;
const CHIP_POWER: u8 = 0x02;
const ADC_POWER: u8 = 0x03;
const DAC_POWER: u8 = 0x04;
const MASTER_MODE: u8 = 0x08;
const ADC_CONTROL1: u8 = 0x09;
const ADC_CONTROL2: u8 = 0x0a;
const ADC_CONTROL3: u8 = 0x0b;
const ADC_CONTROL4: u8 = 0x0c;
const ADC_CONTROL5: u8 = 0x0d;
const ADC_CONTROL8: u8 = 0x10;
const ADC_CONTROL9: u8 = 0x11;
const DAC_CONTROL1: u8 = 0x17;
const DAC_CONTROL2: u8 = 0x18;
const DAC_CONTROL3: u8 = 0x19;
const DAC_CONTROL16: u8 = 0x26;
const DAC_CONTROL17: u8 = 0x27;
const DAC_CONTROL20: u8 = 0x2a;
const DAC_CONTROL21: u8 = 0x2b;
const DAC_CONTROL23: u8 = 0x2d;

impl CodecDriver for Es8388 {
    fn configure(bus: &mut I2cDriver<'_>, address: u8, audio: AudioSettings) -> Result<()> {
        // Reset/normal power state and I2S slave clocking.
        for (register, value) in [
            (DAC_CONTROL3, 0x04),
            (CONTROL2, 0x50),
            (CHIP_POWER, 0x00),
            (0x35, 0xa0),
            (0x37, 0xd0),
            (0x39, 0xd0),
            (MASTER_MODE, 0x00),
            // DAC is electrically disabled; these settings keep the codec's
            // shared LRCK clock topology compatible with the board.
            (DAC_POWER, 0xc0),
            (CONTROL1, 0x12),
            (DAC_CONTROL1, 0x18),
            (DAC_CONTROL2, 0x02),
            (DAC_CONTROL16, 0x00),
            (DAC_CONTROL17, 0x90),
            (DAC_CONTROL20, 0x90),
            (DAC_CONTROL21, 0x80),
            (DAC_CONTROL23, 0x00),
            (DAC_POWER, 0x00),
            // ADC, 16-bit normal I2S, 256*fs clock ratio.
            (ADC_POWER, 0xff),
            (ADC_CONTROL1, input_gain_register(audio.input_gain)),
            (ADC_CONTROL2, input_register(audio.input_line)),
            (ADC_CONTROL3, 0x02),
            (ADC_CONTROL4, 0x0d),
            (ADC_CONTROL5, 0x02),
            (ADC_CONTROL8, attenuation_register(audio.adc_attenuation_db)),
            (ADC_CONTROL9, attenuation_register(audio.adc_attenuation_db)),
            (ADC_POWER, 0x09),
        ] {
            bus.write(address, &[register, value], BLOCK)?;
        }
        Ok(())
    }

    fn apply(bus: &mut I2cDriver<'_>, address: u8, audio: AudioSettings) -> Result<()> {
        for (register, value) in input_controls(audio) {
            bus.write(address, &[register, value], BLOCK)?;
        }
        Ok(())
    }
}

/// The register writes for the user-adjustable input settings — the live
/// subset of the full `configure` sequence.
const fn input_controls(audio: AudioSettings) -> [(u8, u8); 4] {
    [
        (ADC_CONTROL1, input_gain_register(audio.input_gain)),
        (ADC_CONTROL2, input_register(audio.input_line)),
        (ADC_CONTROL8, attenuation_register(audio.adc_attenuation_db)),
        (ADC_CONTROL9, attenuation_register(audio.adc_attenuation_db)),
    ]
}

/// ES8388 input mux for the board's line numbers. Settings are validated
/// against the board descriptor before they reach the codec, so an unknown
/// line cannot arrive here; the fallback keeps the mapping total.
const fn input_register(line: u8) -> u8 {
    match line {
        1 => 0x00,
        _ => 0x50,
    }
}

/// Maps the public 0..=100 setting to the ES8388's nine 3 dB PGA steps.
const fn input_gain_register(gain: u8) -> u8 {
    let step = (gain as u16 * 8 / 100) as u8;
    (step << 4) | step
}

/// ES8388 ADC attenuation uses 0.5 dB units.
const fn attenuation_register(db: u8) -> u8 {
    db.saturating_mul(2)
}

#[cfg(test)]
mod tests {
    use super::{
        attenuation_register, input_controls, input_gain_register, input_register, ADC_CONTROL1,
        ADC_CONTROL2, ADC_CONTROL8, ADC_CONTROL9,
    };
    use crate::config::AudioSettings;

    #[test]
    fn maps_audio_controls_to_documented_register_values() {
        assert_eq!(input_register(1), 0x00);
        assert_eq!(input_register(2), 0x50);
        assert_eq!(input_gain_register(0), 0x00);
        assert_eq!(input_gain_register(100), 0x88);
        assert_eq!(attenuation_register(48), 96);
    }

    #[test]
    fn live_apply_writes_exactly_the_input_control_registers() {
        let audio = AudioSettings {
            input_line: 2,
            input_gain: 0,
            adc_attenuation_db: 9,
        };
        assert_eq!(
            input_controls(audio),
            [
                (ADC_CONTROL1, 0x00),
                (ADC_CONTROL2, 0x50),
                (ADC_CONTROL8, 18),
                (ADC_CONTROL9, 18),
            ]
        );
    }
}
