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
};
use serde::Serialize;

use crate::{
    adapters::time,
    update::{self, ImageSink, ImageSource, InstallProgress, OtaRelease},
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
    fn begin(&self) -> bool {
        let busy = matches!(
            Phase::from_u8(self.phase.load(Ordering::Relaxed)),
            Phase::Checking | Phase::Downloading | Phase::Verifying
        );
        if busy {
            return false;
        }
        self.written.store(0, Ordering::Relaxed);
        self.total.store(0, Ordering::Relaxed);
        self.set_phase(Phase::Checking);
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
/// Called once the device has booted far enough to be considered healthy (Wi-Fi
/// up, streaming started). On a slot that is not pending verification this is a
/// no-op, so the normal boot path can call it unconditionally.
pub fn mark_current_valid() {
    match EspOta::new().and_then(|mut ota| ota.mark_running_slot_valid()) {
        Ok(()) => log::info!("running firmware slot confirmed valid"),
        Err(error) => log::warn!("could not mark firmware slot valid: {error}"),
    }
}

/// Kick off a check-and-install on a worker thread. The HTTP handler returns
/// immediately; callers poll [`OtaProgress::snapshot`] for status. A successful
/// install reboots the device into the new slot.
pub fn spawn_update(progress: Arc<OtaProgress>) -> Result<()> {
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
        .spawn(move || run(&progress))
        .context("cannot spawn OTA task");

    ThreadSpawnConfiguration::default()
        .set()
        .context("cannot restore default task configuration")?;

    spawned.map(drop)
}

fn run(progress: &OtaProgress) {
    let current = env!("CARGO_PKG_VERSION");
    progress.set_message("synchronizing clock");
    if let Err(error) = time::wait_for_sync() {
        return progress.fail(format!("time synchronization failed: {error:#}"));
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

    progress.set_phase(Phase::Downloading);
    if let Err(error) = install(&release, progress) {
        return progress.fail(format!("install failed: {error:#}"));
    }

    progress.set_phase(Phase::Installed);
    progress.set_message(&format!("installed {}; rebooting", release.version));
    log::info!("OTA installed {}; rebooting", release.version);
    // Let the HTTP status poll observe the final state before the reboot.
    esp_idf_svc::hal::delay::FreeRtos::delay_ms(1_000);
    unsafe { esp_idf_svc::sys::esp_restart() };
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
/// wires the HTTPS response and the flash slot into it and commits or discards
/// the slot on the outcome.
fn install(release: &OtaRelease, progress: &OtaProgress) -> Result<()> {
    let url = download_url(&release.filename);
    let mut client = client()?;
    let mut response = client
        .get(&url)
        .and_then(|request| request.submit())
        .map_err(|error| anyhow!("{error:?}"))?;
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
        update::install_verified(&mut source, &mut sink, &release.sha256, &mut reporter)
    };
    match outcome {
        Ok(()) => slot.complete().context("cannot finalize OTA image"),
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
