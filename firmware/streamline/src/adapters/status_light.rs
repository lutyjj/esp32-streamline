//! ESP-IDF GPIO renderer for the board's assignable LEDs.

use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::Result;
use esp_idf_svc::hal::{
    delay::FreeRtos,
    gpio::{Output, PinDriver},
};

use crate::{
    adapters::pins, board::Board, config::RuntimeConfig, health::Severity, indicator, led::LedRole,
    stream::StreamStatus,
};

const REFRESH_MS: u32 = 50;

/// A board LED bound to its GPIO for the process lifetime, so no runtime path
/// shares a pin.
struct RenderedLed {
    id: String,
    active_low: bool,
    default_role: LedRole,
    output: PinDriver<'static, Output>,
}

/// Start rendering the board's LEDs. Each tick resolves every LED's effective
/// role from the live configuration, so a role change through the API applies
/// without a reboot. A board with no LEDs starts no task.
pub fn start(
    board: Arc<Board>,
    config: Arc<Mutex<RuntimeConfig>>,
    is_setup: bool,
    health: Severity,
    stream: Option<Arc<StreamStatus>>,
) -> Result<()> {
    if board.leds.is_empty() {
        return Ok(());
    }
    let mut leds = Vec::with_capacity(board.leds.len());
    for led in &board.leds {
        leds.push(RenderedLed {
            id: led.id.clone(),
            active_low: led.active_low,
            default_role: led.default_role,
            output: PinDriver::output(pins::output_pin(led.gpio))?,
        });
    }
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
                let elapsed = started.elapsed().as_millis() as u32;
                let roles = config
                    .lock()
                    .map(|config| config.led_roles.clone())
                    .unwrap_or_default();
                for led in &mut leds {
                    let role = roles.get(&led.id).copied().unwrap_or(led.default_role);
                    let lit = role.is_lit_at(state, elapsed);
                    let drive_high = lit != led.active_low;
                    let result = if drive_high {
                        led.output.set_high()
                    } else {
                        led.output.set_low()
                    };
                    if let Err(error) = result {
                        log::error!("LED '{}' GPIO write failed: {error}", led.id);
                    }
                }
                FreeRtos::delay_ms(REFRESH_MS);
            }
        })?;
    Ok(())
}
