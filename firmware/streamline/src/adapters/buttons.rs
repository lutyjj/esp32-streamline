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

/// The resident poll task only reads GPIOs and debounces; it matches the
/// status-light task's budget. Keeping this small matters: thread stacks are
/// heap allocations, and the OTA check's TLS peak needs most of the free heap.
const POLL_STACK_BYTES: usize = 4_096;

/// Executing an action can serialize a complete state generation, the same
/// work the HTTP server sizes its stack for — so each press runs on a
/// transient worker that returns its stack to the heap when the action ends.
const ACTION_STACK_BYTES: usize = 16_384;

/// A board button bound to its GPIO for the process lifetime, so no runtime
/// path shares a pin.
struct PolledButton {
    id: String,
    active_low: bool,
    input: PinDriver<'static, Input>,
    detector: PressDetector,
}

/// How long the boot-time probe lets the pull settle before sampling.
const PROBE_SETTLE_MS: u32 = 10;

/// Whether the board's first button is held right now. Sampled once at boot,
/// before the setup AP starts: a held button is the physical-presence signal
/// that opens the AP for one boot when the password is unavailable (a worn
/// label, a lost note). The pin driver is dropped before the poll task
/// claims it. A board without buttons has no override.
pub fn setup_override_held(board: &board::Board) -> bool {
    let Some(spec) = board.buttons.first() else {
        return false;
    };
    let pull = button_pull(spec.gpio, spec.active_low);
    match PinDriver::input(pins::input_pin(spec.gpio), pull) {
        Ok(input) => {
            FreeRtos::delay_ms(PROBE_SETTLE_MS);
            input.is_low() == spec.active_low
        }
        Err(error) => {
            log::warn!("setup-override button probe failed: {error:#}");
            false
        }
    }
}

/// The pull a button pin needs: internal pulls live on the output-capable
/// pads; input-only pins (GPIO 34–39) rely on the board's own resistor.
fn button_pull(gpio: u8, active_low: bool) -> Pull {
    if !board::is_output_gpio(gpio) {
        Pull::Floating
    } else if active_low {
        Pull::Up
    } else {
        Pull::Down
    }
}

/// Start polling the board's buttons. A board with no buttons starts no task.
pub fn start(state: Arc<ApiState>) -> Result<()> {
    if state.board.buttons.is_empty() {
        return Ok(());
    }
    let mut buttons = Vec::with_capacity(state.board.buttons.len());
    for spec in &state.board.buttons {
        let pull = button_pull(spec.gpio, spec.active_low);
        buttons.push(PolledButton {
            id: spec.id.clone(),
            active_low: spec.active_low,
            input: PinDriver::input(pins::input_pin(spec.gpio), pull)?,
            detector: PressDetector::new(),
        });
    }
    std::thread::Builder::new()
        .name("buttons".to_owned())
        .stack_size(POLL_STACK_BYTES)
        .spawn(move || loop {
            for polled in &mut buttons {
                let pressed = polled.input.is_low() == polled.active_low;
                if polled.detector.update(pressed) {
                    let action = effective_action(&state, &polled.id);
                    log::info!("button '{}' pressed: {}", polled.id, action.as_str());
                    spawn_action(&state, action);
                }
            }
            FreeRtos::delay_ms(POLL_MS);
        })?;
    Ok(())
}

/// Run one press's action on a transient worker and return. Spawn failure —
/// for example no heap for the stack while an OTA runs — drops the press with
/// a log line instead of taking the poll task down.
fn spawn_action(state: &Arc<ApiState>, action: ButtonAction) {
    if action == ButtonAction::None {
        return;
    }
    let state = Arc::clone(state);
    let spawned = std::thread::Builder::new()
        .name("button-action".to_owned())
        .stack_size(ACTION_STACK_BYTES)
        .spawn(move || execute(&state, action));
    if let Err(error) = spawned {
        log::warn!(
            "button action '{}' could not start: {error}",
            action.as_str()
        );
    }
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
        ButtonAction::CycleInput => change_audio(state, action, |board, audio| AudioSettings {
            input_line: button::next_input_line(board, audio.input_line),
            ..audio
        }),
        ButtonAction::GainUp => change_audio(state, action, |board, audio| AudioSettings {
            input_gain: button::stepped_gain(board, audio.input_gain, true),
            ..audio
        }),
        ButtonAction::GainDown => change_audio(state, action, |board, audio| AudioSettings {
            input_gain: button::stepped_gain(board, audio.input_gain, false),
            ..audio
        }),
        ButtonAction::AttenuationUp => change_audio(state, action, |board, audio| AudioSettings {
            adc_attenuation_db: button::stepped_attenuation(board, audio.adc_attenuation_db, true),
            ..audio
        }),
        ButtonAction::AttenuationDown => {
            change_audio(state, action, |board, audio| AudioSettings {
                adc_attenuation_db: button::stepped_attenuation(
                    board,
                    audio.adc_attenuation_db,
                    false,
                ),
                ..audio
            })
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

/// Apply an audio-mutating action through the same validate-persist-apply
/// flow as `POST /api/settings/audio`. A press that would not change anything
/// — a step already at its limit — writes nothing, so a held button at the
/// end of a range cannot wear flash.
fn change_audio(
    state: &Arc<ApiState>,
    action: ButtonAction,
    next: impl FnOnce(&crate::board::Board, AudioSettings) -> AudioSettings,
) {
    let current = match state.config.lock() {
        Ok(config) => config.audio,
        Err(_) => {
            log::error!("{} failed: configuration lock poisoned", action.as_str());
            return;
        }
    };
    let audio = next(state.board.as_ref(), current);
    if audio == current {
        log::info!("{}: already at the limit", action.as_str());
        return;
    }
    match http::set_audio(state, audio) {
        Ok(_) => log::info!(
            "{}: audio now line {} gain {} attenuation {} dB",
            action.as_str(),
            audio.input_line,
            audio.input_gain,
            audio.adc_attenuation_db
        ),
        Err(error) => log::warn!("{} failed: {}", action.as_str(), error.message()),
    }
}

fn restart() -> ! {
    unsafe { esp_idf_svc::sys::esp_restart() }
}
