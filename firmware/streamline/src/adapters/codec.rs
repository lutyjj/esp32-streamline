//! ESP-IDF I2C binding for the portable codec controller.

use crate::{
    adapters::pins::I2cBusPins,
    board::CodecSpec,
    codec::{Driver, RegisterBus},
    config::AudioSettings,
};
use anyhow::{anyhow, Result};
use esp_idf_svc::hal::{
    delay::FreeRtos,
    i2c::{I2cConfig, I2cDriver, I2C0},
    units::Hertz,
};

pub type DeviceCodec<'d> = crate::codec::CodecControl<I2cRegisterBus<'d>>;

const REGISTER_WRITE_TIMEOUT_MS: u64 = 100;

pub struct I2cRegisterBus<'d> {
    driver: I2cDriver<'d>,
    address: u8,
}

impl RegisterBus for I2cRegisterBus<'_> {
    fn write(&mut self, register: u8, value: u8) -> Result<()> {
        self.driver.write(
            self.address,
            &[register, value],
            esp_idf_svc::hal::delay::TickType::new_millis(REGISTER_WRITE_TIMEOUT_MS).ticks(),
        )?;
        Ok(())
    }

    fn delay_ms(&mut self, millis: u32) {
        FreeRtos::delay_ms(millis);
    }
}

pub fn configure<'d>(
    i2c: I2C0<'d>,
    pins: I2cBusPins<'d>,
    codec: &CodecSpec,
    audio: AudioSettings,
) -> Result<DeviceCodec<'d>> {
    let driver = Driver::resolve(&codec.driver)
        .map_err(|error| anyhow!("unsupported codec driver: {error:?}"))?;
    let config = I2cConfig::new()
        .baudrate(Hertz(100_000))
        .sda_enable_pullup(true)
        .scl_enable_pullup(true);
    let bus = I2cRegisterBus {
        driver: I2cDriver::new(i2c, pins.sda, pins.scl, &config)?,
        address: codec.i2c_address,
    };
    DeviceCodec::new(bus, driver, audio)
}
