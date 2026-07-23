//! Over-the-air firmware updates from GitHub releases.
//!
//! The device discovers and pulls updates itself through GitHub's
//! `releases/latest/download/` redirect: it fetches the small `SHA256SUMS`,
//! selects the published application image (see [`crate::update`]), streams it
//! over TLS straight into the inactive OTA slot while hashing, and only flips
//! the boot pointer once the digest matches. A freshly booted slot stays in
//! pending-verify until [`mark_current_valid`] confirms it, so a bad image
//! rolls back instead of bricking the device.

use std::{
    sync::{
        atomic::{AtomicU32, AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
};

use anyhow::{anyhow, bail, Context, Result};
use embedded_svc::{
    http::{client::Client, Headers},
    io::Read,
    utils::io::try_read_full,
};
use esp_idf_svc::{
    hal::task::thread::ThreadSpawnConfiguration,
    http::client::{Configuration, EspHttpConnection, FollowRedirectsPolicy},
    ota::EspOta,
    sys,
};
use serde::Serialize;

use crate::{
    adapters::{nvs::ConfigStore, time},
    update::{self, CustomImage, ImageSink, ImageSource, InstallProgress, OtaRelease},
};

/// GitHub repository that publishes releases. The `latest/download/` path always
/// resolves to the newest release's assets, so no API token or version lookup is
/// needed.
const REPO: &str = "lutyjj/esp32-streamline";
/// TLS plus the HTTP client and SHA-256 hashing need a roomier stack than the
/// default worker.
const WORKER_STACK_BYTES: usize = 16_384;
const READ_CHUNK_BYTES: usize = 4_096;
/// Guard against a malformed or hostile checksum listing exhausting the heap.
const MAX_SUMS_BYTES: usize = 8_192;

/// Whether this firmware enforces vendor RSA-3072 signatures on over-the-air
/// images (`CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT`). `esp_ota` verifies
/// the signature against the running app's embedded public key before it commits
/// a slot, so an image the vendor did not sign is never committed by OTA. This
/// guards the network path, not boot-time or physical-flash tampering (that
/// needs Secure Boot). Read from the sdkconfig option esp-idf-sys propagates as
/// a cfg, so status stays honest on an unsigned self-build (which reports
/// `false`).
pub const SIGNED_UPDATES: bool = cfg!(esp_idf_secure_signed_on_update_no_secure_boot);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Phase {
    Idle = 0,
    Checking = 1,
    UpToDate = 2,
    Downloading = 3,
    Verifying = 4,
    /// Image flashed and verified; the device is about to reboot into it.
    Installed = 5,
    Failed = 6,
    /// A check found a newer release; the user can choose to install it.
    UpdateAvailable = 7,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Checking => "checking",
            Phase::UpToDate => "up-to-date",
            Phase::Downloading => "downloading",
            Phase::Verifying => "verifying",
            Phase::Installed => "installed",
            Phase::Failed => "failed",
            Phase::UpdateAvailable => "update-available",
        }
    }

    fn from_u8(value: u8) -> Self {
        match value {
            1 => Phase::Checking,
            2 => Phase::UpToDate,
            3 => Phase::Downloading,
            4 => Phase::Verifying,
            5 => Phase::Installed,
            6 => Phase::Failed,
            7 => Phase::UpdateAvailable,
            _ => Phase::Idle,
        }
    }
}

/// Shared, lock-light progress the HTTP status endpoint reads while an update
/// runs on its own worker thread.
pub struct OtaProgress {
    phase: AtomicU8,
    written: AtomicU32,
    total: AtomicU32,
    detail: Mutex<Detail>,
}

#[derive(Default)]
struct Detail {
    latest_version: String,
    message: String,
}

#[derive(Serialize)]
pub struct OtaSnapshot {
    pub phase: &'static str,
    pub bytes_written: u32,
    pub bytes_total: u32,
    pub latest_version: String,
    pub message: String,
    pub busy: bool,
}

impl Default for OtaProgress {
    fn default() -> Self {
        Self {
            phase: AtomicU8::new(Phase::Idle as u8),
            written: AtomicU32::new(0),
            total: AtomicU32::new(0),
            detail: Mutex::new(Detail::default()),
        }
    }
}

impl OtaProgress {
    pub fn snapshot(&self) -> OtaSnapshot {
        let phase = Phase::from_u8(self.phase.load(Ordering::Relaxed));
        let detail = self.detail.lock().expect("ota detail lock poisoned");
        OtaSnapshot {
            phase: phase.as_str(),
            bytes_written: self.written.load(Ordering::Relaxed),
            bytes_total: self.total.load(Ordering::Relaxed),
            latest_version: detail.latest_version.clone(),
            message: detail.message.clone(),
            busy: matches!(
                phase,
                Phase::Checking | Phase::Downloading | Phase::Verifying
            ),
        }
    }

    /// Reserve the worker: returns `false` if an update is already running.
    /// Compare-and-swap on the phase makes the reservation atomic, so two
    /// concurrent trigger requests can never both start a worker.
    fn begin(&self) -> bool {
        let mut current = self.phase.load(Ordering::Relaxed);
        loop {
            let busy = matches!(
                Phase::from_u8(current),
                Phase::Checking | Phase::Downloading | Phase::Verifying
            );
            if busy {
                return false;
            }
            match self.phase.compare_exchange(
                current,
                Phase::Checking as u8,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(actual) => current = actual,
            }
        }
        self.written.store(0, Ordering::Relaxed);
        self.total.store(0, Ordering::Relaxed);
        self.set_message("");
        true
    }

    fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Relaxed);
    }

    fn set_progress(&self, written: u32, total: u32) {
        self.written.store(written, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
    }

    fn set_latest(&self, version: &str) {
        self.detail
            .lock()
            .expect("ota detail lock poisoned")
            .latest_version = version.to_owned();
    }

    fn set_message(&self, message: &str) {
        self.detail
            .lock()
            .expect("ota detail lock poisoned")
            .message = message.to_owned();
    }

    fn fail(&self, message: String) {
        log::warn!("OTA update failed: {message}");
        self.set_message(&message);
        self.set_phase(Phase::Failed);
    }
}

/// Confirm the running slot so the rollback watchdog accepts this image as good.
///
/// Called once the device has booted far enough to be manageable (Wi-Fi and the
/// console are up). On a slot that is not pending verification this is a
/// no-op, so the normal boot path can call it unconditionally.
pub fn mark_current_valid() {
    match EspOta::new().and_then(|mut ota| ota.mark_running_slot_valid()) {
        Ok(()) => log::info!("running firmware slot confirmed valid"),
        Err(error) => log::warn!("could not mark firmware slot valid: {error}"),
    }
}

/// The inactive OTA slot when it holds a valid, bootable image; `None` when
/// there is nothing to roll back to (a freshly serial-flashed device has only
/// one slot written).
fn valid_rollback_slot() -> Option<*const sys::esp_partition_t> {
    // SAFETY: the OTA partition APIs only read the partition table and otadata.
    let other = unsafe { sys::esp_ota_get_next_update_partition(core::ptr::null()) };
    if other.is_null() {
        return None;
    }
    let mut state = sys::esp_ota_img_states_t_ESP_OTA_IMG_UNDEFINED;
    let read = unsafe { sys::esp_ota_get_state_partition(other, &mut state) };
    (read == sys::ESP_OK && state == sys::esp_ota_img_states_t_ESP_OTA_IMG_VALID).then_some(other)
}

/// The firmware version the device would roll back into, when a valid previous
/// slot exists. `Some("")` when the slot is valid but its version cannot be
/// read; `None` when there is nothing to roll back to. Read fresh — rollback
/// availability is fixed between reboots, and an OTA install reboots.
pub fn rollback_target() -> Option<String> {
    let slot = valid_rollback_slot()?;
    let mut desc: sys::esp_app_desc_t = unsafe { core::mem::zeroed() };
    // SAFETY: `slot` is a live partition pointer; the call fills `desc`.
    if unsafe { sys::esp_ota_get_partition_description(slot, &mut desc) } == sys::ESP_OK {
        let raw = unsafe { std::ffi::CStr::from_ptr(desc.version.as_ptr().cast()) }
            .to_string_lossy()
            .into_owned();
        // The app descriptor version carries a leading `v` from the release tag;
        // drop it so rollback_version matches the `firmware_version` format the
        // console prefixes.
        Some(raw.strip_prefix('v').map(str::to_owned).unwrap_or(raw))
    } else {
        Some(String::new())
    }
}

/// Point the next boot at the inactive slot, returning to the previous firmware.
/// Instant and offline — no re-download. The slot boots in pending-verify, so
/// the normal boot path confirms it (or the bootloader bounces back), which
/// keeps the manual rollback as safe as an automatic one. Refuses when there is
/// no valid image to return to; the caller reboots on success.
pub fn select_rollback_slot() -> Result<()> {
    let slot = valid_rollback_slot()
        .ok_or_else(|| anyhow!("no valid previous firmware to roll back to"))?;
    // SAFETY: `slot` is a valid partition verified just above.
    let err = unsafe { sys::esp_ota_set_boot_partition(slot) };
    if err != sys::ESP_OK {
        bail!("could not select the previous firmware slot (error {err})");
    }
    log::info!("selected the previous firmware slot for the next boot");
    Ok(())
}

/// Where an install pulls its image from.
pub enum Source {
    /// The newest published GitHub release; refused unless strictly newer than
    /// the running firmware.
    LatestRelease,
    /// An exact URL pinned by its digest; installs regardless of version, so a
    /// development build can replace any release. See [`CustomImage`].
    Custom(CustomImage),
}

/// Whether a worker should stop after checking or go on to install.
enum Action {
    /// Report whether a newer release exists, then stop.
    Check,
    /// Download the image from `Source`, verify, and reboot into it.
    Install(Source),
}

/// Check GitHub for a newer release without installing anything. The HTTP
/// handler returns immediately; callers poll [`OtaProgress::snapshot`] for the
/// result (`up-to-date` or `update-available`).
pub fn spawn_check(progress: Arc<OtaProgress>) -> Result<()> {
    spawn(progress, Action::Check, None)
}

/// Kick off an install on a worker thread. The HTTP handler returns
/// immediately; callers poll [`OtaProgress::snapshot`] for status. A successful
/// install reboots the device into the new slot; the outcome is persisted in
/// `store` so it survives the reboot (and a possible rollback).
pub fn spawn_update(
    progress: Arc<OtaProgress>,
    store: Arc<Mutex<ConfigStore>>,
    source: Source,
) -> Result<()> {
    spawn(progress, Action::Install(source), Some(store))
}

fn spawn(
    progress: Arc<OtaProgress>,
    action: Action,
    store: Option<Arc<Mutex<ConfigStore>>>,
) -> Result<()> {
    if !progress.begin() {
        bail!("an update is already in progress");
    }

    ThreadSpawnConfiguration {
        name: Some(c"ota-update"),
        stack_size: WORKER_STACK_BYTES,
        ..Default::default()
    }
    .set()
    .context("cannot configure OTA task")?;

    let spawned = thread::Builder::new()
        .stack_size(WORKER_STACK_BYTES)
        .spawn(move || run(&progress, action, store.as_deref()))
        .context("cannot spawn OTA task");

    ThreadSpawnConfiguration::default()
        .set()
        .context("cannot restore default task configuration")?;

    spawned.map(drop)
}

fn run(progress: &OtaProgress, action: Action, store: Option<&Mutex<ConfigStore>>) {
    if let Action::Install(Source::Custom(image)) = &action {
        // A custom image is digest-pinned and version-agnostic, so no release
        // check. Clock sync exists only for TLS certificate validation; a
        // plain-HTTP image skips it so an offline dev bench can still install.
        if image.needs_tls() {
            if let Err(error) = sync_clock(progress) {
                return progress.fail(error);
            }
        }
        return install_and_reboot(
            &image.url,
            &image.sha256,
            image.display_name(),
            progress,
            store,
        );
    }

    let current = env!("CARGO_PKG_VERSION");
    if let Err(error) = sync_clock(progress) {
        return progress.fail(error);
    }
    progress.set_message("checking latest release");
    let release = match check() {
        Ok(release) => release,
        Err(error) => return progress.fail(format!("update check failed: {error:#}")),
    };
    progress.set_latest(&release.version);

    if !update::is_newer(current, &release.version) {
        progress.set_message(&format!("already on the latest release ({current})"));
        progress.set_phase(Phase::UpToDate);
        return;
    }

    if let Action::Check = action {
        progress.set_message(&format!("update {} available", release.version));
        progress.set_phase(Phase::UpdateAvailable);
        return;
    }

    install_and_reboot(
        &download_url(&release.filename),
        &release.sha256,
        &release.version,
        progress,
        store,
    );
}

fn sync_clock(progress: &OtaProgress) -> Result<(), String> {
    progress.set_message("synchronizing clock");
    time::wait_for_sync().map_err(|error| format!("time synchronization failed: {error:#}"))
}

/// Download, verify, and boot into the image at `url`; `what` is a non-sensitive
/// name for progress messages and persisted notes ("0.3.3", "custom image").
fn install_and_reboot(
    url: &str,
    sha256: &str,
    what: &str,
    progress: &OtaProgress,
    store: Option<&Mutex<ConfigStore>>,
) {
    progress.set_phase(Phase::Downloading);
    // Written before the download so a crash mid-install still leaves evidence;
    // overwritten by the final outcome below.
    note_outcome(store, &format!("installing {what} (did not finish)"));
    if let Err(error) = install(url, sha256, progress) {
        let message = format!("install {what} failed: {error:#}");
        note_outcome(store, &message);
        return progress.fail(message);
    }

    let message = format!("installed {what}; rebooting");
    note_outcome(store, &message);
    progress.set_phase(Phase::Installed);
    progress.set_message(&message);
    log::info!("OTA {message}");
    // Let the console's status poll (1.5 s interval) observe the final state
    // before the reboot; a shorter window can fall between two polls.
    esp_idf_svc::hal::delay::FreeRtos::delay_ms(3_000);
    unsafe { esp_idf_svc::sys::esp_restart() };
}

/// Persist the install outcome, tagged with the version that ran the install,
/// so `/api/status` can still explain what happened after the reboot — and
/// after a rollback, when the running version contradicts the note.
/// Best-effort: diagnostics must never fail an update.
fn note_outcome(store: Option<&Mutex<ConfigStore>>, outcome: &str) {
    let Some(store) = store else { return };
    let note = format!("v{}: {outcome}", env!("CARGO_PKG_VERSION"));
    match store.lock() {
        Ok(guard) => {
            if let Err(error) = guard.save_last_ota(&note) {
                log::warn!("could not persist OTA outcome: {error:#}");
            }
        }
        Err(_) => log::warn!("could not persist OTA outcome: store lock poisoned"),
    }
}

fn client() -> Result<Client<EspHttpConnection>> {
    let connection = EspHttpConnection::new(&Configuration {
        crt_bundle_attach: Some(esp_idf_svc::sys::esp_crt_bundle_attach),
        follow_redirects_policy: FollowRedirectsPolicy::FollowAll,
        buffer_size: Some(READ_CHUNK_BYTES),
        buffer_size_tx: Some(1024),
        ..Default::default()
    })
    .context("cannot create HTTPS client")?;
    Ok(Client::wrap(connection))
}

fn download_url(asset: &str) -> String {
    format!("https://github.com/{REPO}/releases/latest/download/{asset}")
}

/// Fetch and parse the latest release's `SHA256SUMS` to learn the OTA image's
/// filename and expected digest.
fn check() -> Result<OtaRelease> {
    let url = download_url("SHA256SUMS");
    let mut client = client()?;
    let mut response = client
        .get(&url)
        .and_then(|request| request.submit())
        .map_err(|error| anyhow!("{error:?}"))?;
    let status = response.status();
    if status != 200 {
        bail!("checksum fetch returned HTTP {status}");
    }

    let mut body = Vec::new();
    let mut chunk = [0_u8; 512];
    loop {
        let read = response
            .read(&mut chunk)
            .map_err(|error| anyhow!("{error:?}"))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > MAX_SUMS_BYTES {
            bail!("checksum listing is implausibly large");
        }
    }

    let text = std::str::from_utf8(&body).context("checksum listing is not UTF-8")?;
    update::parse_release(text).ok_or_else(|| anyhow!("release has no OTA image"))
}

/// Stream the application image into the inactive slot, verifying its SHA-256
/// before committing the boot pointer.
///
/// The verifying-download logic lives in [`update::install_verified`]; this only
/// wires the HTTP response and the flash slot into it and commits or discards
/// the slot on the outcome.
fn install(url: &str, sha256: &str, progress: &OtaProgress) -> Result<()> {
    let mut client = client()?;
    let mut response = client
        .get(url)
        .and_then(|request| request.submit())
        .map_err(|_| anyhow!("download request failed"))?;
    let status = response.status();
    if status != 200 {
        bail!("download returned HTTP {status}");
    }
    let total = response.content_len().unwrap_or(0) as u32;
    progress.set_progress(0, total);

    let mut ota = EspOta::new().context("cannot open OTA partition set")?;
    let mut slot = ota.initiate_update().context("cannot begin OTA write")?;

    let outcome = {
        let mut source = ResponseSource(&mut response);
        let mut sink = SlotSink(&mut slot);
        let mut reporter = Reporter { progress, total };
        update::install_verified(&mut source, &mut sink, sha256, &mut reporter)
    };
    match outcome {
        // `complete()` runs esp_ota_end, which verifies the appended RSA
        // signature against the running app's public key when signed updates are
        // enforced. A forged or unsigned image fails here with
        // ESP_ERR_OTA_VALIDATE_FAILED; name that so the failure is legible in
        // status and diagnostics rather than a bare error code.
        Ok(()) => slot.complete().map_err(|error| {
            if error.code() == sys::ESP_ERR_OTA_VALIDATE_FAILED {
                anyhow!("image signature verification failed: not signed by this device's key")
            } else {
                anyhow!("cannot finalize OTA image: {error}")
            }
        }),
        Err(error) => {
            let _ = slot.abort();
            Err(anyhow!("{error}"))
        }
    }
}

/// Adapts an HTTPS response body to the byte source the installer reads from.
struct ResponseSource<'a, R: Read>(&'a mut R);

impl<R: Read> ImageSource for ResponseSource<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        try_read_full(&mut *self.0, buffer).map_err(|error| format!("{:?}", error.0))
    }
}

/// Adapts an OTA flash slot to the byte sink the installer writes to.
struct SlotSink<'a, 'b>(&'a mut esp_idf_svc::ota::EspOtaUpdate<'b>);

impl ImageSink for SlotSink<'_, '_> {
    fn write(&mut self, chunk: &[u8]) -> Result<(), String> {
        use embedded_svc::io::Write;
        self.0
            .write_all(chunk)
            .map_err(|error| format!("{error:?}"))
    }
}

/// Surfaces installer lifecycle events on the shared [`OtaProgress`].
struct Reporter<'a> {
    progress: &'a OtaProgress,
    total: u32,
}

impl InstallProgress for Reporter<'_> {
    fn downloaded(&mut self, bytes: u32) {
        self.progress.set_progress(bytes, self.total);
    }
    fn verifying(&mut self) {
        self.progress.set_phase(Phase::Verifying);
    }
}
