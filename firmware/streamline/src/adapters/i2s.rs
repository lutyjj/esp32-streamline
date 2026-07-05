//! I2S RX capture on the safe `esp-idf-hal` driver.

use anyhow::Result;
use esp_idf_svc::hal::{
    delay::BLOCK,
    i2s::{
        config::{DataBitWidth, StdConfig},
        I2sDriver, I2sRx, I2S0,
    },
};

use crate::{
    adapters::pins::I2sBusPins,
    protocol::{PAYLOAD_BYTES, SAMPLE_RATE_HZ},
};

/// Owns the RX driver for the application lifetime. The capture task reads whole
/// packets from it; the standard-mode driver handles DMA, clocking, and its own
/// teardown, so no `unsafe` or manual `Drop` is needed.
pub struct Capture {
    driver: I2sDriver<'static, I2sRx>,
}

impl Capture {
    /// Configure Philips standard format, 48 kHz/16-bit stereo, MCLK at 256x
    /// the sample rate to clock the codec.
    pub fn new(i2s: I2S0<'static>, pins: I2sBusPins<'static>) -> Result<Self> {
        let config = StdConfig::philips(SAMPLE_RATE_HZ, DataBitWidth::Bits16);
        let mut driver =
            I2sDriver::new_std_rx(i2s, &config, pins.bclk, pins.din, Some(pins.mclk), pins.ws)?;
        driver.rx_enable()?;
        Ok(Self { driver })
    }

    pub fn read(&mut self, samples: &mut [u8; PAYLOAD_BYTES]) -> Result<usize> {
        Ok(self.driver.read(samples, BLOCK)?)
    }
}
