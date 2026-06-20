//! I2S RX capture for the ESP32 Audio Kit, on the safe `esp-idf-hal` driver.

use anyhow::Result;
use esp_idf_svc::hal::{
    delay::BLOCK,
    gpio::{Gpio0, Gpio25, Gpio27, Gpio35},
    i2s::{
        config::{DataBitWidth, StdConfig},
        I2sDriver, I2sRx, I2S0,
    },
};

use crate::protocol::{PAYLOAD_BYTES, SAMPLE_RATE_HZ};

/// Owns the RX driver for the application lifetime. The capture task reads whole
/// packets from it; the standard-mode driver handles DMA, clocking, and its own
/// teardown, so no `unsafe` or manual `Drop` is needed.
pub struct Capture {
    driver: I2sDriver<'static, I2sRx>,
}

impl Capture {
    /// Configure the original ESP32 Audio Kit pin map: MCLK GPIO0, BCLK GPIO27,
    /// LRCLK GPIO25, DIN GPIO35. Philips standard format, 48 kHz/16-bit stereo,
    /// MCLK at 256x the sample rate to clock the ES8388.
    pub fn new(
        i2s: I2S0<'static>,
        bclk: Gpio27<'static>,
        din: Gpio35<'static>,
        mclk: Gpio0<'static>,
        ws: Gpio25<'static>,
    ) -> Result<Self> {
        let config = StdConfig::philips(SAMPLE_RATE_HZ, DataBitWidth::Bits16);
        let mut driver = I2sDriver::new_std_rx(i2s, &config, bclk, din, Some(mclk), ws)?;
        driver.rx_enable()?;
        Ok(Self { driver })
    }

    pub fn read(&mut self, samples: &mut [u8; PAYLOAD_BYTES]) -> Result<usize> {
        Ok(self.driver.read(samples, BLOCK)?)
    }
}
