//! Minimal audio codec configuration.
//!
//! This is deliberately not a port of the Arduino audio-driver abstraction.
//! The register sequence is the small, auditable subset required for ES8388
//! line-in capture and an optional board-advertised analog monitor route.
//!
//! A board descriptor selects a codec driver by stable id. New codec chips add
//! one implementation plus one resolver entry; capture and transport never name
//! a codec.

use anyhow::{anyhow, Result};
use esp_idf_svc::hal::{
    delay::{FreeRtos, BLOCK},
    i2c::{I2cConfig, I2cDriver, I2C0},
    units::Hertz,
};

use crate::{
    adapters::pins::I2cBusPins,
    analog_passthrough::{
        route_for_audio_change, AnalogPassthroughControl, AnalogPassthroughRoute,
    },
    board::CodecSpec,
    codec::Driver,
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

    fn apply_with_passthrough(
        bus: &mut I2cDriver<'_>,
        address: u8,
        audio: AudioSettings,
        route: AnalogPassthroughRoute,
    ) -> Result<()>;

    fn enable_passthrough(
        bus: &mut I2cDriver<'_>,
        address: u8,
        route: AnalogPassthroughRoute,
    ) -> Result<()>;

    fn disable_passthrough(bus: &mut I2cDriver<'_>, address: u8) -> Result<()>;
}

impl Driver {
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

    fn apply_with_passthrough(
        self,
        bus: &mut I2cDriver<'_>,
        address: u8,
        audio: AudioSettings,
        route: AnalogPassthroughRoute,
    ) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::apply_with_passthrough(bus, address, audio, route),
        }
    }

    fn enable_passthrough(
        self,
        bus: &mut I2cDriver<'_>,
        address: u8,
        route: AnalogPassthroughRoute,
    ) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::enable_passthrough(bus, address, route),
        }
    }

    fn disable_passthrough(self, bus: &mut I2cDriver<'_>, address: u8) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::disable_passthrough(bus, address),
        }
    }
}

/// Open the control bus, configure the board's codec, and return a handle that
/// can re-apply input settings while the device streams.
pub fn configure<'d>(
    i2c: I2C0<'d>,
    pins: I2cBusPins<'d>,
    codec: &CodecSpec,
    audio: AudioSettings,
) -> Result<CodecControl<'d>> {
    let driver = Driver::resolve(&codec.driver)
        .map_err(|error| anyhow!("unsupported codec driver '{}': {error:?}", codec.driver))?;
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
        audio,
        passthrough: None,
    })
}

/// Owns the codec's I2C control bus after boot so input settings can change
/// without rebooting the device.
pub struct CodecControl<'d> {
    bus: I2cDriver<'d>,
    driver: Driver,
    i2c_address: u8,
    audio: AudioSettings,
    passthrough: Option<AnalogPassthroughRoute>,
}

impl CodecControl<'_> {
    /// Apply new input settings to the running codec.
    pub fn apply(&mut self, audio: AudioSettings) -> Result<()> {
        let route = self.passthrough.and_then(|current| {
            route_for_audio_change(true, self.audio, audio, current.output_line)
        });
        let result = match route {
            Some(route) => {
                self.driver
                    .apply_with_passthrough(&mut self.bus, self.i2c_address, audio, route)
            }
            None => self.driver.apply(&mut self.bus, self.i2c_address, audio),
        };
        if let Err(error) = result {
            if self.passthrough.is_some() {
                let close = self
                    .driver
                    .disable_passthrough(&mut self.bus, self.i2c_address);
                self.passthrough = None;
                if let Err(close_error) = close {
                    return Err(anyhow!("{error:#}; fail-close failed: {close_error:#}"));
                }
            }
            return Err(error);
        }
        self.audio = audio;
        if let Some(route) = route {
            self.passthrough = Some(route);
        }
        Ok(())
    }
}

impl AnalogPassthroughControl for CodecControl<'_> {
    type Error = anyhow::Error;

    fn enable(&mut self, route: AnalogPassthroughRoute) -> Result<()> {
        self.driver
            .enable_passthrough(&mut self.bus, self.i2c_address, route)?;
        self.passthrough = Some(route);
        Ok(())
    }

    fn disable(&mut self) -> Result<()> {
        let result = self
            .driver
            .disable_passthrough(&mut self.bus, self.i2c_address);
        self.passthrough = None;
        result
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
const LOUT1_VOLUME: u8 = 0x2e;
const ROUT1_VOLUME: u8 = 0x2f;
const LOUT2_VOLUME: u8 = 0x30;
const ROUT2_VOLUME: u8 = 0x31;

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
            (ADC_CONTROL2, input_register(audio.input_line)?),
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
        for (register, value) in input_controls(audio)? {
            bus.write(address, &[register, value], BLOCK)?;
        }
        Ok(())
    }

    fn apply_with_passthrough(
        bus: &mut I2cDriver<'_>,
        address: u8,
        audio: AudioSettings,
        route: AnalogPassthroughRoute,
    ) -> Result<()> {
        passthrough_output(route.output_line)?;
        write(bus, address, DAC_CONTROL3, 0x04)?;
        Self::apply(bus, address, audio)?;
        write(
            bus,
            address,
            DAC_CONTROL16,
            passthrough_input_register(route.input_line)?,
        )?;
        FreeRtos::delay_ms(100);
        write(bus, address, DAC_CONTROL3, 0x00)
    }

    fn enable_passthrough(
        bus: &mut I2cDriver<'_>,
        address: u8,
        route: AnalogPassthroughRoute,
    ) -> Result<()> {
        let (left_volume, right_volume, power) = passthrough_output(route.output_line)?;
        // DAC_CONTROL21 stays at the ADC-owned LRCK configuration established
        // during capture setup; the raw analog mixer does not need to change it.
        for (register, value) in [
            (DAC_CONTROL3, 0x04),
            (DAC_CONTROL16, passthrough_input_register(route.input_line)?),
            (DAC_CONTROL17, 0x50),
            (DAC_CONTROL20, 0x50),
            (left_volume, 0x1e),
            (right_volume, 0x1e),
            (DAC_POWER, power),
        ] {
            write(bus, address, register, value)?;
        }
        FreeRtos::delay_ms(100);
        write(bus, address, DAC_CONTROL3, 0x00)
    }

    fn disable_passthrough(bus: &mut I2cDriver<'_>, address: u8) -> Result<()> {
        // Attempt every fail-close write even when the bus reports an earlier
        // error. Powering the output pair down is more important than cleanup.
        let mut first_error = None;
        for (register, value) in [
            (DAC_CONTROL3, 0x04),
            (DAC_POWER, 0x00),
            (DAC_CONTROL17, 0x90),
            (DAC_CONTROL20, 0x90),
        ] {
            if let Err(error) = write(bus, address, register, value) {
                first_error.get_or_insert(error);
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(())
    }
}

fn write(bus: &mut I2cDriver<'_>, address: u8, register: u8, value: u8) -> Result<()> {
    bus.write(address, &[register, value], BLOCK)?;
    Ok(())
}

fn passthrough_input_register(line: u8) -> Result<u8> {
    match line {
        1 => Ok(0x00),
        2 => Ok(0x09),
        _ => Err(anyhow!("unsupported ES8388 passthrough input line {line}")),
    }
}

fn passthrough_output(line: u8) -> Result<(u8, u8, u8)> {
    match line {
        1 => Ok((LOUT1_VOLUME, ROUT1_VOLUME, 0x30)),
        2 => Ok((LOUT2_VOLUME, ROUT2_VOLUME, 0x0c)),
        _ => Err(anyhow!("unsupported ES8388 passthrough output line {line}")),
    }
}

/// The register writes for the user-adjustable input settings — the live
/// subset of the full `configure` sequence.
fn input_controls(audio: AudioSettings) -> Result<[(u8, u8); 4]> {
    Ok([
        (ADC_CONTROL1, input_gain_register(audio.input_gain)),
        (ADC_CONTROL2, input_register(audio.input_line)?),
        (ADC_CONTROL8, attenuation_register(audio.adc_attenuation_db)),
        (ADC_CONTROL9, attenuation_register(audio.adc_attenuation_db)),
    ])
}

/// ES8388 input mux for the driver-supported line numbers.
fn input_register(line: u8) -> Result<u8> {
    match line {
        1 => Ok(0x00),
        2 => Ok(0x50),
        _ => Err(anyhow!("unsupported ES8388 input line {line}")),
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
        assert_eq!(input_register(1), Ok(0x00));
        assert_eq!(input_register(2), Ok(0x50));
        assert!(input_register(3).is_err());
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
            input_controls(audio).expect("supported line"),
            [
                (ADC_CONTROL1, 0x00),
                (ADC_CONTROL2, 0x50),
                (ADC_CONTROL8, 18),
                (ADC_CONTROL9, 18),
            ]
        );
    }
}
