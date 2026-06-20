//! Minimal, board-specific audio codec configuration.
//!
//! This is deliberately not a port of the Arduino audio-driver abstraction.
//! The register sequence is the small, auditable subset required for the
//! original ESP32 Audio Kit: ES8388 in I2S slave mode, 48 kHz/16-bit stereo,
//! an ADC input selected from line one or two, and no DAC output.
//!
//! The [`Codec`] trait keeps the ES8388 as one implementation so other
//! ESP32-A1S codec variants (for example the AC101 at I2C `0x1A`) can be added
//! as their own `Codec` impl without touching the capture or transport paths.

use anyhow::Result;
use esp_idf_svc::hal::{
    delay::BLOCK,
    gpio::{Gpio32, Gpio33},
    i2c::{I2cConfig, I2cDriver, I2C0},
    units::Hertz,
};

use crate::config::{AudioSettings, InputLine};

/// A line-in capture codec on the shared I2C control bus.
pub trait Codec {
    /// 7-bit I2C address the codec answers on.
    const I2C_ADDRESS: u8;

    /// Apply the capture configuration over an already-open I2C bus: I2S slave
    /// at 48 kHz/16-bit stereo, with the selected input line, gain, and ADC
    /// attenuation.
    fn configure(bus: &mut I2cDriver<'_>, audio: AudioSettings) -> Result<()>;
}

/// Open the control bus and configure the board's codec.
pub fn configure<'d>(
    i2c: I2C0<'d>,
    sda: Gpio33<'d>,
    scl: Gpio32<'d>,
    audio: AudioSettings,
) -> Result<()> {
    let config = I2cConfig::new()
        .baudrate(Hertz(100_000))
        .sda_enable_pullup(true)
        .scl_enable_pullup(true);
    let mut bus = I2cDriver::new(i2c, sda, scl, &config)?;
    Es8388::configure(&mut bus, audio)
}

/// ES8388 ADC at I2C `0x10` — the codec on the Ai-Thinker ESP32-A1S / Audio Kit.
pub struct Es8388;

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

impl Codec for Es8388 {
    const I2C_ADDRESS: u8 = 0x10;

    fn configure(bus: &mut I2cDriver<'_>, audio: AudioSettings) -> Result<()> {
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
            bus.write(Self::I2C_ADDRESS, &[register, value], BLOCK)?;
        }
        Ok(())
    }
}

const fn input_register(line: InputLine) -> u8 {
    match line {
        InputLine::One => 0x00,
        InputLine::Two => 0x50,
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
    use super::{attenuation_register, input_gain_register, input_register};
    use crate::config::InputLine;

    #[test]
    fn maps_audio_controls_to_documented_register_values() {
        assert_eq!(input_register(InputLine::One), 0x00);
        assert_eq!(input_register(InputLine::Two), 0x50);
        assert_eq!(input_gain_register(0), 0x00);
        assert_eq!(input_gain_register(100), 0x88);
        assert_eq!(attenuation_register(48), 96);
    }
}
