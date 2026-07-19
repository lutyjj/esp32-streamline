//! ESP-IDF GPIO poll task for the board's assignable buttons.
//!
//! Each tick debounces every button through [`crate::button::PressDetector`]
//! and resolves a press to its effective action from the live configuration,
//! so an assignment through the API applies without a reboot. Every action is
//! the press-driven twin of an API capability and goes through the same flow
//! the HTTP handler uses; a press can never do what a client cannot.

use std::sync::Arc;

use anyhow::Result;
use esp_idf_svc::hal::{
    delay::FreeRtos,
    gpio::{Input, PinDriver, Pull},
};

use crate::{
    adapters::{
        http::{self, ApiState},
        pins,
    },
    board,
    button::{self, ButtonAction, PressDetector},
    config::AudioSettings,
};

const POLL_MS: u32 = 20;

/// A board button bound to its GPIO for the process lifetime, so no runtime
/// path shares a pin.
struct PolledButton {
    id: String,
    active_low: bool,
    input: PinDriver<'static, Input>,
    detector: PressDetector,
}

/// Start polling the board's buttons. A board with no buttons starts no task.
pub fn start(state: Arc<ApiState>) -> Result<()> {
    if state.board.buttons.is_empty() {
        return Ok(());
    }
    let mut buttons = Vec::with_capacity(state.board.buttons.len());
    for spec in &state.board.buttons {
        // Internal pulls live on the output-capable pads; input-only pins
        // (GPIO 34–39) rely on the board's own resistor.
        let pull = if !board::is_output_gpio(spec.gpio) {
            Pull::Floating
        } else if spec.active_low {
            Pull::Up
        } else {
            Pull::Down
        };
        buttons.push(PolledButton {
            id: spec.id.clone(),
            active_low: spec.active_low,
            input: PinDriver::input(pins::input_pin(spec.gpio), pull)?,
            detector: PressDetector::new(),
        });
    }
    std::thread::Builder::new()
        .name("buttons".to_owned())
        .stack_size(8_192)
        .spawn(move || loop {
            for polled in &mut buttons {
                let pressed = polled.input.is_low() == polled.active_low;
                if polled.detector.update(pressed) {
                    let action = effective_action(&state, &polled.id);
                    log::info!("button '{}' pressed: {}", polled.id, action.as_str());
                    execute(&state, action);
                }
            }
            FreeRtos::delay_ms(POLL_MS);
        })?;
    Ok(())
}

/// The pressed button's action from the live configuration, falling back to
/// its descriptor default when the configuration is unreadable.
fn effective_action(state: &ApiState, id: &str) -> ButtonAction {
    let Some(spec) = state.board.button(id) else {
        return ButtonAction::None;
    };
    match state.config.lock() {
        Ok(config) => config.button_action(spec),
        Err(_) => spec.default_action,
    }
}

fn execute(state: &Arc<ApiState>, action: ButtonAction) {
    match action {
        ButtonAction::None => {}
        ButtonAction::ToggleStream => match &state.stream {
            Some(stream) => {
                let enabled = !stream.streaming_enabled();
                stream.set_streaming_enabled(enabled);
                log::info!("streaming {}", if enabled { "resumed" } else { "paused" });
            }
            None => log::warn!("toggle_stream ignored: audio capture is not running"),
        },
        ButtonAction::CycleInput => {
            let current = match state.config.lock() {
                Ok(config) => config.audio,
                Err(_) => {
                    log::error!("cycle_input failed: configuration lock poisoned");
                    return;
                }
            };
            let next = button::next_input_line(state.board.as_ref(), current.input_line);
            let audio = AudioSettings {
                input_line: next,
                ..current
            };
            match http::set_audio(state, audio) {
                Ok(_) => log::info!("input line switched to {next}"),
                Err(error) => log::warn!("cycle_input failed: {}", error.message()),
            }
        }
        ButtonAction::Restart => {
            log::info!("restarting on button press");
            restart();
        }
        ButtonAction::FactoryReset => {
            match state.store.lock() {
                Ok(store) => {
                    if let Err(error) = store.clear() {
                        log::error!("factory reset failed: {error:#}");
                        return;
                    }
                }
                Err(_) => {
                    log::error!("factory reset failed: store lock poisoned");
                    return;
                }
            }
            log::info!("settings erased on button press; rebooting into setup");
            restart();
        }
    }
}

fn restart() -> ! {
    unsafe { esp_idf_svc::sys::esp_restart() }
}
