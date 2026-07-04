use std::sync::{Arc, Mutex};

use anyhow::Result;
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{delay::FreeRtos, peripherals::Peripherals},
    nvs::EspDefaultNvsPartition,
};
use streamline_firmware::{
    adapters::{
        codec,
        http::{self, ApiState, Mode},
        i2s::Capture,
        nvs::ConfigStore,
        ota,
        tcp::TargetAddress,
        time, wifi,
    },
    config::{AudioSettings, InputLine, RuntimeConfig},
    runtime,
};

fn main() -> Result<()> {
    // Required by esp-idf-sys to link runtime patches on an ESP-IDF target.
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    let peripherals = Peripherals::take()?;
    let event_loop = EspSystemEventLoop::take()?;
    let nvs_partition = EspDefaultNvsPartition::take()?;
    let store = Arc::new(Mutex::new(ConfigStore::open(nvs_partition.clone())?));
    let persisted = store
        .lock()
        .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
        .load()?;
    let mut wifi = wifi::create(peripherals.modem, event_loop, nvs_partition)?;
    let suffix = wifi::device_suffix()?;

    let (mode, config, stream, codec) = match persisted {
        Some(config) => match wifi::connect_station(&mut wifi, &config) {
            Ok(()) => match TargetAddress::resolve(&config) {
                Ok(target) => {
                    let capture = Capture::new(
                        peripherals.i2s0,
                        peripherals.pins.gpio27,
                        peripherals.pins.gpio35,
                        peripherals.pins.gpio0,
                        peripherals.pins.gpio25,
                    )?;
                    let codec = codec::configure(
                        peripherals.i2c0,
                        peripherals.pins.gpio33,
                        peripherals.pins.gpio32,
                        config.audio,
                    )?;
                    let stream = runtime::start(capture, target)?;
                    log::info!("StreamLine Rust firmware started TCP streaming");
                    (
                        Mode::Streaming,
                        config,
                        Some(stream),
                        Some(Arc::new(Mutex::new(codec))),
                    )
                }
                Err(error) => {
                    let reason = format!("TCP target resolution failed: {error:#}");
                    log::warn!("{reason}; opening setup AP");
                    note_fallback(&store, &reason);
                    start_setup(&mut wifi, &suffix)?
                }
            },
            Err(error) => {
                let reason = format!("Wi-Fi station connection failed: {error:#}");
                log::warn!("{reason}; opening setup AP");
                note_fallback(&store, &reason);
                start_setup(&mut wifi, &suffix)?
            }
        },
        None => start_setup(&mut wifi, &suffix)?,
    };

    // Reaching a healthy streaming state is the signal an over-the-air image
    // booted correctly; confirm the slot so the rollback watchdog accepts it. A
    // device that fell back to the setup AP stays in pending-verify and reverts
    // to the previous firmware on the next reboot.
    if mode == Mode::Streaming {
        if let Err(error) = time::start() {
            log::warn!("SNTP initialization failed: {error:#}");
        }
        ota::mark_current_valid();
    }

    let state = Arc::new(ApiState {
        mode,
        config: Arc::new(Mutex::new(config)),
        store,
        stream,
        codec,
        ota: Arc::new(ota::OtaProgress::default()),
    });
    let _server = http::start(state)?;
    loop {
        FreeRtos::delay_ms(1_000);
    }
}

/// Persist why this boot fell back to the setup AP, tagged with the running
/// version so a post-rollback reading still tells which image failed.
/// Best-effort: diagnostics must never take the boot down.
fn note_fallback(store: &Arc<Mutex<ConfigStore>>, reason: &str) {
    let note = format!("v{}: {reason}", env!("CARGO_PKG_VERSION"));
    match store.lock() {
        Ok(guard) => {
            if let Err(error) = guard.save_last_fallback(&note) {
                log::warn!("could not persist fallback reason: {error:#}");
            }
        }
        Err(_) => log::warn!("could not persist fallback reason: store lock poisoned"),
    }
}

type SetupState = (
    Mode,
    RuntimeConfig,
    Option<Arc<runtime::StreamStatus>>,
    Option<Arc<Mutex<codec::CodecControl<'static>>>>,
);

fn start_setup(wifi: &mut wifi::WifiController<'_>, suffix: &str) -> Result<SetupState> {
    let ssid = wifi::start_setup_ap(wifi, suffix)?;
    log::info!("setup AP started: {ssid}");
    Ok((
        Mode::SetupAp,
        RuntimeConfig {
            ssid: String::new(),
            password: String::new(),
            target_host: String::new(),
            target_port: 39_000,
            // No admin key yet: an unprovisioned device accepts setup writes over its
            // own AP so commissioning can establish one. See `http::authorized`.
            admin_secret: String::new(),
            // Safe line-in baseline: 0 dB PGA (no clipping) on line 2. Adjust per
            // board in setup mode.
            audio: AudioSettings {
                input_line: InputLine::Two,
                input_gain: 0,
                adc_attenuation_db: 0,
            },
        },
        None,
        None,
    ))
}
