use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{delay::FreeRtos, i2c::I2C0, i2s::I2S0, peripherals::Peripherals},
    nvs::EspDefaultNvsPartition,
};
use streamline_firmware::{
    adapters::{
        codec,
        http::{self, ApiState, Mode},
        i2s::Capture,
        mdns::MdnsAdvertisement,
        nvs::ConfigStore,
        ota,
        pins::AudioPins,
        tcp::TargetAddress,
        time, wifi,
    },
    board::{self, Board},
    config::{AudioSettings, RuntimeConfig},
    identity, runtime,
};

fn main() -> Result<()> {
    // Required by esp-idf-sys to link runtime patches on an ESP-IDF target.
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    let Peripherals {
        modem, i2c0, i2s0, ..
    } = Peripherals::take()?;
    let event_loop = EspSystemEventLoop::take()?;
    let nvs_partition = EspDefaultNvsPartition::take()?;
    let store = Arc::new(Mutex::new(ConfigStore::open(nvs_partition.clone())?));
    let board_catalog = Arc::new(
        board::builtin_catalog()
            .map_err(|error| anyhow::anyhow!("invalid built-in board catalog: {error}"))?,
    );
    let board_selection = store
        .lock()
        .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
        .load_board_selection(&board_catalog)?;
    let board = Arc::new(board_selection.board().clone());
    log::info!("using board descriptor '{}'", board.id);
    let persisted = if board_selection.is_resolved() {
        store
            .lock()
            .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
            .load(board.as_ref())?
    } else {
        None
    };
    let mut wifi = wifi::create(modem, event_loop, nvs_partition)?;
    let suffix = wifi::device_suffix()?;
    let mdns_hostname = wifi::mdns_hostname()?;
    let local_hostname = identity::local_hostname(&mdns_hostname);

    let (mode, config, stream, codec) = match persisted {
        Some(config) => match wifi::connect_station(&mut wifi, &config) {
            Ok(()) => match resolve_target(&config) {
                Ok(target) => match start_audio(i2c0, i2s0, board.as_ref(), &config, target) {
                    Ok((stream, codec)) => {
                        log::info!(
                            "StreamLine provisioned; {}",
                            if target.is_some() {
                                "streaming over TCP"
                            } else {
                                "capturing until a bridge target is set"
                            }
                        );
                        (Mode::Provisioned, config, Some(stream), Some(codec))
                    }
                    Err(error) => {
                        let reason = format!("audio hardware initialization failed: {error:#}");
                        log::warn!("{reason}; opening setup AP");
                        note_fallback(&store, &reason);
                        start_setup(&mut wifi, &suffix, board.as_ref())?
                    }
                },
                Err(error) => {
                    let reason = format!("TCP target resolution failed: {error:#}");
                    log::warn!("{reason}; opening setup AP");
                    note_fallback(&store, &reason);
                    start_setup(&mut wifi, &suffix, board.as_ref())?
                }
            },
            Err(error) => {
                let reason = format!("Wi-Fi station connection failed: {error:#}");
                log::warn!("{reason}; opening setup AP");
                note_fallback(&store, &reason);
                start_setup(&mut wifi, &suffix, board.as_ref())?
            }
        },
        None => start_setup(&mut wifi, &suffix, board.as_ref())?,
    };

    // Reaching the home network with the console up is the signal an
    // over-the-air image booted correctly; confirm the slot so the rollback
    // watchdog accepts it. A device that fell back to the setup AP stays in
    // pending-verify and reverts to the previous firmware on the next reboot.
    if mode == Mode::Provisioned {
        if let Err(error) = time::start() {
            log::warn!("SNTP initialization failed: {error:#}");
        }
        ota::mark_current_valid();
    }

    let mdns = if mode == Mode::Provisioned {
        match MdnsAdvertisement::start(&mdns_hostname, &config) {
            Ok(advertisement) => Some(Arc::new(Mutex::new(advertisement))),
            Err(error) => {
                log::warn!("mDNS advertisement failed: {error:#}");
                None
            }
        }
    } else {
        None
    };

    let state = Arc::new(ApiState {
        mode,
        hostname: local_hostname,
        config: Arc::new(Mutex::new(config)),
        board_catalog,
        board,
        store,
        stream,
        codec,
        mdns,
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

/// The stream target for a provisioned boot: `None` when no bridge is
/// configured yet, so capture runs without a network task.
fn resolve_target(config: &RuntimeConfig) -> Result<Option<TargetAddress>> {
    if config.target_host.is_empty() {
        return Ok(None);
    }
    TargetAddress::resolve(config).map(Some)
}

type ProvisionedAudio = (
    Arc<runtime::StreamStatus>,
    Arc<Mutex<codec::CodecControl<'static>>>,
);

fn start_audio(
    i2c0: I2C0<'static>,
    i2s0: I2S0<'static>,
    board: &Board,
    config: &RuntimeConfig,
    target: Option<TargetAddress>,
) -> Result<ProvisionedAudio> {
    let audio_pins = AudioPins::new(board.pins);
    let capture = Capture::new(i2s0, audio_pins.i2s).context("I2S capture setup failed")?;
    let codec = codec::configure(i2c0, audio_pins.i2c, &board.codec, config.audio)
        .context("codec setup failed")?;
    let stream = runtime::start(capture, target).context("capture task setup failed")?;
    Ok((stream, Arc::new(Mutex::new(codec))))
}

type SetupState = (
    Mode,
    RuntimeConfig,
    Option<Arc<runtime::StreamStatus>>,
    Option<Arc<Mutex<codec::CodecControl<'static>>>>,
);

fn start_setup(
    wifi: &mut wifi::WifiController<'_>,
    suffix: &str,
    board: &Board,
) -> Result<SetupState> {
    let ssid = wifi::start_setup_ap(wifi, suffix)?;
    log::info!("setup AP started: {ssid}");
    Ok((
        Mode::Setup,
        RuntimeConfig {
            ssid: String::new(),
            password: String::new(),
            target_host: String::new(),
            target_port: 39_000,
            // No admin key yet: an unprovisioned device accepts setup writes over its
            // own AP so commissioning can establish one. See `http::authorized`.
            admin_secret: String::new(),
            device_name: String::new(),
            // Safe line-in baseline: 0 dB PGA (no clipping) on line 2. Adjust per
            // board in setup mode.
            audio: AudioSettings {
                input_line: board.default_line(),
                input_gain: 0,
                adc_attenuation_db: 0,
            },
        },
        None,
        None,
    ))
}
