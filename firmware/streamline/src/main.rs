use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::Result;
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
    config::{AudioSettings, AutoUpdateSchedule, RuntimeConfig},
    health::{BootFacts, HealthReport},
    identity, runtime, update,
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

    let (mode, config, stream, codec, health) = match persisted {
        Some(config) => match wifi::connect_station(&mut wifi, &config) {
            // Wi-Fi is up, so the device is reachable on the home network and
            // stays provisioned. A bridge target that will not resolve or audio
            // that will not initialize is a fault to surface through the health
            // check, not a reason to drop to the setup AP — that recovery is for
            // no network. Staying provisioned also lets `mark_current_valid`
            // confirm the slot below, so an audio fault can never trigger a
            // rollback.
            Ok(()) => {
                let target = match resolve_target(&config) {
                    Ok(target) => target,
                    Err(error) => {
                        log::warn!(
                            "TCP target resolution failed: {error:#}; \
                             staying provisioned without a stream"
                        );
                        None
                    }
                };
                let audio = start_audio(i2c0, i2s0, board.as_ref(), &config, target);
                if let Err(reason) = &audio.result {
                    log::warn!("{reason}; staying provisioned so the fault is reachable");
                }
                let health = Arc::new(HealthReport::assess(&BootFacts {
                    audio: Some(audio.result),
                    bridge_configured: !config.target_host.is_empty(),
                    board_name: board.name.clone(),
                }));
                log::info!(
                    "StreamLine provisioned; startup health: {:?}",
                    health.status
                );
                (Mode::Provisioned, config, audio.stream, audio.codec, health)
            }
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

    // Rollback availability is fixed until the next OTA install, which reboots,
    // so read the inactive slot once here rather than on every status poll and
    // metrics scrape.
    let rollback = ota::rollback_target();

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
        health,
        rollback,
    });
    let _server = http::start(Arc::clone(&state))?;
    let booted_at = Instant::now();
    let mut auto_update_timer = update::AutoUpdateTimer::default();
    loop {
        FreeRtos::delay_ms(1_000);
        if mode != Mode::Provisioned {
            continue;
        }
        let schedule = state
            .config
            .lock()
            .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
            .auto_update_schedule;
        let audio_idle = state
            .stream
            .as_ref()
            .map(|stream| !stream.snapshot().playing)
            .unwrap_or(true);
        if auto_update_timer.take_due(booted_at.elapsed(), schedule, audio_idle) {
            log::info!("automatic firmware update check started");
            if let Err(error) = ota::spawn_update(
                Arc::clone(&state.ota),
                Arc::clone(&state.store),
                ota::Source::LatestRelease,
            ) {
                log::warn!("automatic firmware update check could not start: {error:#}");
            }
        }
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

/// Audio bring-up outcome: the live handles when everything came up, plus the
/// single fact the health check reads. A fault leaves `stream`/`codec` `None`
/// and the device reachable, rather than tearing the boot down.
struct AudioOutcome {
    stream: Option<Arc<runtime::StreamStatus>>,
    codec: Option<Arc<Mutex<codec::CodecControl<'static>>>>,
    /// `Ok` when the codec answered and the capture task started; `Err(reason)`
    /// otherwise, phrased for a person reading the health check.
    result: Result<(), String>,
}

fn start_audio(
    i2c0: I2C0<'static>,
    i2s0: I2S0<'static>,
    board: &Board,
    config: &RuntimeConfig,
    target: Option<TargetAddress>,
) -> AudioOutcome {
    let audio_pins = AudioPins::new(board.pins);
    let capture = match Capture::new(i2s0, audio_pins.i2s) {
        Ok(capture) => capture,
        Err(error) => return AudioOutcome::failed(format!("I2S capture setup failed: {error:#}")),
    };
    let codec = match codec::configure(i2c0, audio_pins.i2c, &board.codec, config.audio) {
        Ok(codec) => codec,
        Err(error) => return AudioOutcome::failed(format!("codec setup failed: {error:#}")),
    };
    match runtime::start(capture, target) {
        Ok(stream) => AudioOutcome {
            stream: Some(stream),
            codec: Some(Arc::new(Mutex::new(codec))),
            result: Ok(()),
        },
        Err(error) => AudioOutcome::failed(format!("capture task setup failed: {error:#}")),
    }
}

impl AudioOutcome {
    fn failed(reason: String) -> Self {
        Self {
            stream: None,
            codec: None,
            result: Err(reason),
        }
    }
}

type SetupState = (
    Mode,
    RuntimeConfig,
    Option<Arc<runtime::StreamStatus>>,
    Option<Arc<Mutex<codec::CodecControl<'static>>>>,
    Arc<HealthReport>,
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
            auto_update_schedule: AutoUpdateSchedule::Daily,
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
        // Nothing to check until the device reaches the home network.
        Arc::new(HealthReport::healthy()),
    ))
}
