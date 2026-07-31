use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use anyhow::Result;
#[cfg(not(feature = "qemu"))]
use esp_idf_svc::hal::{i2c::I2C0, i2s::I2S0};
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{delay::FreeRtos, peripherals::Peripherals},
    nvs::EspDefaultNvsPartition,
};
#[cfg(feature = "qemu")]
use streamline_firmware::adapters::openeth;
#[cfg(not(feature = "qemu"))]
use streamline_firmware::adapters::{
    captive_portal::DnsResponder,
    i2s::Capture,
    pins::{AudioPins, I2cBusPins},
    tcp::{TargetAddress, TlsKeyVerifier},
};
use streamline_firmware::{
    adapters::{
        buttons, codec,
        http::{self, ApiState, Mode},
        logs,
        mdns::MdnsAdvertisement,
        nvs::ConfigStore,
        ota,
        random::EspRandom,
        status_light, time, wifi,
    },
    analog_passthrough::AnalogPassthroughState,
    board::{self, Board},
    config::RuntimeConfig,
    health::{BootFacts, HealthReport},
    identity,
    profiles::AudioProfileCatalog,
    recovery,
    setup_network::SetupNetwork,
    stream,
    transport::KeyVerifier,
    update,
};

#[cfg(not(feature = "qemu"))]
use streamline_firmware::{analog_passthrough::AnalogPassthroughRoute, reconnect, runtime};

fn main() -> Result<()> {
    // Required by esp-idf-sys to link runtime patches on an ESP-IDF target.
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();
    // Before anything else logs: this both starts the capture and rescues the
    // previous boot's lines, which a reset leaves in place only until they are
    // written over.
    logs::install();

    let peripherals = Peripherals::take()?;
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
    let audio_profiles = match persisted.as_ref() {
        Some(config) => store
            .lock()
            .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
            .load_audio_profiles(board.as_ref(), config.audio)?,
        None => AudioProfileCatalog::empty(board.as_ref()),
    };
    if persisted.is_some() {
        match store
            .lock()
            .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
            .migrate_legacy(board.as_ref())
        {
            Ok(()) => {}
            Err(error) => log::warn!("could not migrate legacy configuration: {error:#}"),
        }
    }
    let mdns_hostname = wifi::mdns_hostname()?;
    let local_hostname = identity::local_hostname(&mdns_hostname);
    // The setup network's credentials exist in every mode: the AP serves them
    // when it runs, and the factory-reset response shows them. Minted once at
    // first boot and kept in NVS for the device's life, so a pre-flashed
    // unit's label stays true; only a full flash erase mints a fresh one.
    let setup_network = SetupNetwork {
        ssid: identity::setup_ssid(&wifi::device_suffix()?),
        password: store
            .lock()
            .map_err(|_| anyhow::anyhow!("configuration lock poisoned"))?
            .ensure_setup_network_password(&mut EspRandom)?,
    };

    // The network is the one seam between the hardware image and the QEMU
    // image; exactly one `network_boot` variant below compiles into each,
    // and nothing after this call knows which network the device is on.
    let (network, (mode, config, stream, codec, analog_passthrough, health)) = network_boot(
        peripherals,
        event_loop,
        nvs_partition,
        &store,
        &board,
        persisted,
        &setup_network,
    )?;
    // The composition root holds the network link for the life of the process.
    // On hardware the recovery boot loop drives station retries through it; the
    // QEMU link has no radio and only needs to stay alive.
    #[cfg(not(feature = "qemu"))]
    let mut network = network;
    #[cfg(feature = "qemu")]
    let _network = network;

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

    #[cfg(not(feature = "qemu"))]
    let key_verifier = Some(Arc::new(TlsKeyVerifier) as Arc<dyn KeyVerifier>);
    #[cfg(feature = "qemu")]
    let key_verifier: Option<Arc<dyn KeyVerifier>> = None;
    let state = Arc::new(ApiState {
        mode,
        hostname: local_hostname,
        config: Arc::new(Mutex::new(config)),
        audio_profiles: Arc::new(Mutex::new(audio_profiles)),
        board_catalog,
        board,
        store,
        stream,
        key_verifier,
        codec,
        analog_passthrough: Arc::new(Mutex::new(analog_passthrough)),
        mdns,
        ota: Arc::new(ota::OtaProgress::default()),
        health,
        setup_network,
        auth: Mutex::new(streamline_firmware::auth::DigestAuthenticator::default()),
    });
    #[cfg(not(feature = "qemu"))]
    let captive_portal_address = match mode {
        Mode::Setup | Mode::Recovery => match wifi::access_point_address() {
            Some(address) => Some(address),
            None => {
                log::warn!("setup AP address unavailable; captive portal disabled");
                None
            }
        },
        Mode::Provisioned => None,
    };
    #[cfg(feature = "qemu")]
    let captive_portal_address = None;
    if let Err(error) = status_light::start(
        Arc::clone(&state.board),
        Arc::clone(&state.config),
        mode == Mode::Setup,
        state.health.status,
        state.stream.clone(),
    ) {
        log::warn!("status light unavailable: {error:#}");
    }
    if let Err(error) = buttons::start(Arc::clone(&state)) {
        log::warn!("buttons unavailable: {error:#}");
    }
    let _server = http::start(Arc::clone(&state), captive_portal_address)?;
    #[cfg(not(feature = "qemu"))]
    let _dns_responder = match captive_portal_address {
        Some(address) => match DnsResponder::start(address) {
            Ok(responder) => {
                log::info!("setup captive portal ready at http://{address}/");
                Some(responder)
            }
            Err(error) => {
                log::warn!("setup DNS responder unavailable: {error:#}");
                None
            }
        },
        None => None,
    };
    let booted_at = Instant::now();
    let mut auto_update_timer = update::AutoUpdateTimer::default();
    #[cfg(not(feature = "qemu"))]
    let mut reconnect_timer = reconnect::ReconnectTimer::default();
    loop {
        FreeRtos::delay_ms(1_000);
        match mode {
            Mode::Provisioned => {
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
                        state.stream.clone(),
                    ) {
                        log::warn!("automatic firmware update check could not start: {error:#}");
                    }
                }
            }
            // A device that fell back to recovery keeps its setup AP up while it
            // retries the saved Wi-Fi. Once the home network answers, confirm the
            // running slot (reaching it proves the image boots) and reboot into
            // the normal provisioned path, which brings up audio, mDNS, and the
            // stream. Confirming before the reboot keeps a transient outage right
            // after an OTA from tripping the pending-verify rollback.
            #[cfg(not(feature = "qemu"))]
            Mode::Recovery => {
                if reconnect_timer.take_due(booted_at.elapsed()) {
                    log::info!("recovery: retrying the saved Wi-Fi");
                    if wifi::reconnect_station(&mut network) {
                        log::info!(
                            "recovery: home network reachable; confirming slot and rejoining"
                        );
                        ota::mark_current_valid();
                        unsafe { esp_idf_svc::sys::esp_restart() };
                    }
                }
            }
            _ => {}
        }
    }
}

/// What every `network_boot` variant delivers: the live network link, which
/// the composition root holds for the life of the process, and the resolved
/// boot state everything downstream consumes.
type NetworkBoot = (NetworkLink, SetupState);

#[cfg(not(feature = "qemu"))]
type NetworkLink = wifi::WifiController<'static>;
#[cfg(feature = "qemu")]
type NetworkLink = openeth::EthConnection;

// ---------------------------------------------------------------------------
// Hardware image: Wi-Fi station with the setup-AP fallback, audio bring-up.
// ---------------------------------------------------------------------------

#[cfg(not(feature = "qemu"))]
fn network_boot(
    peripherals: Peripherals,
    event_loop: EspSystemEventLoop,
    nvs_partition: EspDefaultNvsPartition,
    store: &Arc<Mutex<ConfigStore>>,
    board: &Arc<Board>,
    persisted: Option<RuntimeConfig>,
    setup_network: &SetupNetwork,
) -> Result<NetworkBoot> {
    let mut wifi = wifi::create(peripherals.modem, event_loop, nvs_partition)?;
    let state = match persisted {
        Some(config) => match wifi::connect_station(&mut wifi, &config) {
            // Wi-Fi is up, so the device is reachable on the home network and
            // stays provisioned. A bridge target that will not resolve or audio
            // that will not initialize is a fault to surface through the health
            // check, not a reason to drop to the setup AP — that recovery is for
            // no network. Staying provisioned also lets `mark_current_valid`
            // confirm the slot, so an audio fault can never trigger a rollback.
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
                let audio = start_audio(
                    peripherals.i2c0,
                    peripherals.i2s0,
                    board.as_ref(),
                    &config,
                    target,
                );
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
                (
                    Mode::Provisioned,
                    config,
                    audio.stream,
                    audio.codec,
                    audio.analog_passthrough,
                    health,
                )
            }
            Err(error) => {
                let reason = format!("Wi-Fi station connection failed: {error:#}");
                log::warn!("{reason}; opening setup AP");
                note_fallback(store, &reason);
                let (codec, analog_passthrough) =
                    start_recovery_local_output(peripherals.i2c0, board.as_ref(), &config);
                let (mode, config, stream, _, _, health) =
                    start_setup(&mut wifi, setup_network, board.as_ref(), Some(config))?;
                (mode, config, stream, codec, analog_passthrough, health)
            }
        },
        None => start_setup(&mut wifi, setup_network, board.as_ref(), None)?,
    };
    Ok((wifi, state))
}

// ---------------------------------------------------------------------------
// QEMU image: emulated Ethernet, no radio and no audio hardware to probe.
// The firmware never depends on this variant; deleting it and the `qemu`
// feature leaves the hardware image untouched.
// ---------------------------------------------------------------------------

#[cfg(feature = "qemu")]
fn network_boot(
    peripherals: Peripherals,
    event_loop: EspSystemEventLoop,
    _nvs_partition: EspDefaultNvsPartition,
    _store: &Arc<Mutex<ConfigStore>>,
    board: &Arc<Board>,
    persisted: Option<RuntimeConfig>,
    // No radio under emulation; the credentials still exist for the API.
    _setup_network: &SetupNetwork,
) -> Result<NetworkBoot> {
    let ethernet = openeth::start(peripherals.mac, event_loop)?;
    let state = match persisted {
        Some(config) => {
            // No I2S or codec exists under emulation, and a probe against
            // missing hardware stalls instead of failing fast, so emulated
            // boots skip audio and surface the fault through health.
            let health = Arc::new(HealthReport::assess(&BootFacts {
                audio: Some(Err("audio capture is not emulated".to_string())),
                bridge_configured: !config.target_host.is_empty(),
                board_name: board.name.clone(),
            }));
            log::info!(
                "StreamLine provisioned; startup health: {:?}",
                health.status
            );
            let mut analog_passthrough = AnalogPassthroughState::default();
            if config.analog_passthrough_enabled {
                analog_passthrough.record_fault("audio capture is not emulated");
            }
            (
                Mode::Provisioned,
                config,
                None,
                None,
                analog_passthrough,
                health,
            )
        }
        None => {
            log::info!("setup console started");
            (
                Mode::Setup,
                recovery::setup_baseline(board.as_ref(), None),
                None,
                None,
                AnalogPassthroughState::default(),
                Arc::new(HealthReport::healthy()),
            )
        }
    };
    Ok((ethernet, state))
}

/// Persist why this boot fell back to the setup AP, tagged with the running
/// version so a post-rollback reading still tells which image failed.
/// Best-effort: diagnostics must never take the boot down.
#[cfg(not(feature = "qemu"))]
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
#[cfg(not(feature = "qemu"))]
fn resolve_target(config: &RuntimeConfig) -> Result<Option<TargetAddress>> {
    if config.target_host.is_empty() {
        return Ok(None);
    }
    TargetAddress::resolve(config).map(Some)
}

/// Audio bring-up outcome: every live handle that came up, plus the single fact
/// the health check reads. A capture fault can retain codec control so an
/// enabled local analog route stays available while the device remains
/// reachable for diagnosis.
#[cfg(not(feature = "qemu"))]
struct AudioOutcome {
    stream: Option<Arc<stream::StreamStatus>>,
    codec: Option<Arc<Mutex<codec::CodecControl<'static>>>>,
    analog_passthrough: AnalogPassthroughState,
    /// `Ok` when the codec answered and the capture task started; `Err(reason)`
    /// otherwise, phrased for a person reading the health check.
    result: Result<(), String>,
}

#[cfg(not(feature = "qemu"))]
fn start_audio(
    i2c0: I2C0<'static>,
    i2s0: I2S0<'static>,
    board: &Board,
    config: &RuntimeConfig,
    target: Option<TargetAddress>,
) -> AudioOutcome {
    let audio_pins = AudioPins::new(board.pins);
    let capture = Capture::new(i2s0, audio_pins.i2s);
    let (codec, analog_passthrough) = match start_codec(i2c0, audio_pins.i2c, board, config) {
        Ok(outcome) => outcome,
        Err(error) => {
            let reason = match capture.as_ref() {
                Ok(_) => format!("codec setup failed: {error:#}"),
                Err(capture_error) => format!(
                    "I2S capture setup failed: {capture_error:#}; codec setup failed: {error:#}"
                ),
            };
            return AudioOutcome::failed(reason, config.analog_passthrough_enabled);
        }
    };
    let capture = match capture {
        Ok(capture) => capture,
        Err(error) => {
            return AudioOutcome::degraded(
                codec,
                analog_passthrough,
                format!("I2S capture setup failed: {error:#}"),
            )
        }
    };
    let stream = match runtime::start(capture, target) {
        Ok(stream) => stream,
        Err(error) => {
            return AudioOutcome::degraded(
                codec,
                analog_passthrough,
                format!("capture task setup failed: {error:#}"),
            )
        }
    };
    AudioOutcome {
        stream: Some(stream),
        codec: Some(Arc::new(Mutex::new(codec))),
        analog_passthrough,
        result: Ok(()),
    }
}

#[cfg(not(feature = "qemu"))]
fn start_codec(
    i2c0: I2C0<'static>,
    i2c_pins: I2cBusPins<'static>,
    board: &Board,
    config: &RuntimeConfig,
) -> Result<(codec::CodecControl<'static>, AnalogPassthroughState)> {
    let mut codec = codec::configure(i2c0, i2c_pins, &board.codec, config.audio)?;
    let route = board
        .analog_passthrough
        .as_ref()
        .map(|capability| AnalogPassthroughRoute {
            input_line: config.audio.input_line,
            output_line: capability.output_line,
        });
    let mut analog_passthrough = AnalogPassthroughState::default();
    if config.analog_passthrough_enabled {
        if let Err(error) = analog_passthrough.reconcile(true, route, &mut codec) {
            log::warn!("local analog output unavailable: {error}");
        }
    }
    Ok((codec, analog_passthrough))
}

#[cfg(not(feature = "qemu"))]
fn start_recovery_local_output(
    i2c0: I2C0<'static>,
    board: &Board,
    config: &RuntimeConfig,
) -> (
    Option<Arc<Mutex<codec::CodecControl<'static>>>>,
    AnalogPassthroughState,
) {
    if !config.analog_passthrough_enabled {
        return (None, AnalogPassthroughState::default());
    }
    let i2c_pins = AudioPins::new(board.pins).i2c;
    match start_codec(i2c0, i2c_pins, board, config) {
        Ok((codec, state)) => (Some(Arc::new(Mutex::new(codec))), state),
        Err(error) => {
            let reason = format!("codec setup failed: {error:#}");
            log::warn!("local analog output unavailable during network recovery: {reason}");
            let mut state = AnalogPassthroughState::default();
            state.record_fault(reason);
            (None, state)
        }
    }
}

#[cfg(not(feature = "qemu"))]
impl AudioOutcome {
    fn failed(reason: String, passthrough_enabled: bool) -> Self {
        let mut analog_passthrough = AnalogPassthroughState::default();
        if passthrough_enabled {
            analog_passthrough.record_fault(reason.clone());
        }
        Self {
            stream: None,
            codec: None,
            analog_passthrough,
            result: Err(reason),
        }
    }

    fn degraded(
        codec: codec::CodecControl<'static>,
        analog_passthrough: AnalogPassthroughState,
        reason: String,
    ) -> Self {
        Self {
            stream: None,
            codec: Some(Arc::new(Mutex::new(codec))),
            analog_passthrough,
            result: Err(reason),
        }
    }
}

type SetupState = (
    Mode,
    RuntimeConfig,
    Option<Arc<stream::StreamStatus>>,
    Option<Arc<Mutex<codec::CodecControl<'static>>>>,
    AnalogPassthroughState,
    Arc<HealthReport>,
);

#[cfg(not(feature = "qemu"))]
fn start_setup(
    wifi: &mut wifi::WifiController<'_>,
    setup_network: &SetupNetwork,
    board: &Board,
    persisted: Option<RuntimeConfig>,
) -> Result<SetupState> {
    // The physical-presence escape hatch: the board's first button, held
    // while power is applied, starts this boot's AP open — for the owner
    // whose label wore off or note went missing. Sampled before the AP
    // starts, and only for this boot.
    let protection = if buttons::setup_override_held(board) {
        wifi::ApProtection::OpenThisBoot
    } else {
        wifi::ApProtection::Wpa2
    };
    // A provisioned device that fell back runs the station beside the AP so it
    // can rejoin its home network on its own; a first-run device is AP-only.
    match persisted.as_ref() {
        Some(config) => wifi::start_recovery_ap(wifi, setup_network, protection, config)?,
        None => wifi::start_setup_ap(wifi, setup_network, protection)?,
    };
    // The one place a DIY build reads its setup password: `espflash monitor`
    // and the WebFlasher's log view both show this line.
    log::info!(
        "setup network ready: SSID \"{}\" password \"{}\" — join it and open http://192.168.71.1/",
        setup_network.ssid,
        setup_network.password
    );
    if protection == wifi::ApProtection::OpenThisBoot {
        log::warn!(
            "setup network is OPEN for this boot: a button was held at power-on; \
             the next restart protects it again"
        );
    }
    Ok((
        if persisted.is_some() {
            Mode::Recovery
        } else {
            Mode::Setup
        },
        recovery::setup_baseline(board, persisted),
        None,
        None,
        AnalogPassthroughState::default(),
        // Nothing to check until the device reaches the home network.
        Arc::new(HealthReport::healthy()),
    ))
}
