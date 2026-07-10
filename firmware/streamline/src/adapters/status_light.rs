//! ESP-IDF GPIO renderer for the board-owned status light.

use std::{sync::Arc, time::Instant};

use anyhow::Result;
use esp_idf_svc::hal::{delay::FreeRtos, gpio::PinDriver};

use crate::{adapters::pins, board::StatusLed, health::Severity, indicator, runtime::StreamStatus};

const REFRESH_MS: u32 = 50;

/// Start rendering status through a board's optional status light. The task
/// owns the GPIO for the process lifetime, so no runtime path shares a pin.
pub fn start(
    led: Option<StatusLed>,
    is_setup: bool,
    health: Severity,
    stream: Option<Arc<StreamStatus>>,
) -> Result<()> {
    let Some(led) = led else {
        return Ok(());
    };
    let mut output = PinDriver::output(pins::output_pin(led.gpio))?;
    std::thread::Builder::new()
        .name("status-light".to_owned())
        .stack_size(4_096)
        .spawn(move || -> ! {
            let started = Instant::now();
            loop {
                let is_streaming = stream
                    .as_ref()
                    .is_some_and(|status| status.snapshot().playing);
                let state = indicator::select(is_setup, health == Severity::Blocking, is_streaming);
                let lit = state.is_lit_at(started.elapsed().as_millis() as u32);
                let drive_high = lit != led.active_low;
                let result = if drive_high {
                    output.set_high()
                } else {
                    output.set_low()
                };
                if let Err(error) = result {
                    log::error!("status light GPIO write failed: {error}");
                }
                FreeRtos::delay_ms(REFRESH_MS);
            }
        })?;
    Ok(())
}
