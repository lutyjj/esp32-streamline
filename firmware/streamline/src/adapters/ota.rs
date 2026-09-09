//! Over-the-air firmware updates from GitHub releases.
//!
//! The device discovers and pulls updates itself through GitHub's
//! `releases/latest/download/` redirect: it fetches the small `SHA256SUMS`,
//! selects the published application image (see [`crate::update`]), streams it
//! over TLS straight into the inactive OTA slot while hashing, and only flips
//! the boot pointer once the digest matches. A freshly booted slot stays in
//! pending-verify until [`mark_current_valid`] confirms it, so a bad image
//! rolls back instead of bricking the device.

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context, Result};
use esp_idf_svc::{hal::task::thread::ThreadSpawnConfiguration, ota::EspOta, sys};

use crate::{
    adapters::{
        download::{HttpGet, TlsRxBuffer},
        nvs::ConfigStore,
        task, time,
    },
    mutation::MutationError,
    stream::StreamStatus,
    update::{
        self,
        progress::{OtaProgress, Phase},
        CustomImage, ImageSink, ImageSource, InstallProgress,
    },
};

/// GitHub repository that publishes releases. The `latest/download/` path always
/// resolves to the newest release's assets, so no API token or version lookup is
/// needed.
const REPO: &str = "lutyjj/esp32-streamline";
/// TLS plus the HTTP client and SHA-256 hashing need a roomier stack than the
/// default worker.
const WORKER_STACK_BYTES: usize = 16_384;
/// How often the install worker rechecks whether the PCM transport released
/// its connection, and how long it waits before giving up on the pause.
const QUIESCE_POLL_MS: u32 = 100;
const QUIESCE_TIMEOUT_MS: u32 = 10_000;
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

/// Confirm the running slot so the rollback watchdog accepts this image as good.
///
/// Called once the device has booted far enough to be manageable (Wi-Fi and the
/// console are up). On a slot that is not pending verification this is a
/// no-op, so the normal boot path can call it unconditionally.
pub fn mark_current_valid() -> Result<()> {
    EspOta::new()?.mark_running_slot_valid()?;
    log::info!("running firmware slot confirmed valid");
    Ok(())
}

pub fn signing_key_sha256() -> &'static str {
    static DIGEST: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DIGEST.get_or_init(|| {
        let mut digests: sys::esp_image_sig_public_key_digests_t = unsafe { core::mem::zeroed() };
        let result = unsafe {
            sys::esp_secure_boot_get_signature_blocks_for_running_app(true, &mut digests)
        };
        if result == sys::ESP_OK && digests.num_digests > 0 {
            crate::hex::encode(&digests.key_digests[0])
        } else {
            String::new()
        }
    })
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
/// read; `None` when there is nothing to roll back to.
///
/// Read fresh on every call: an install erases the inactive slot as soon as it
/// begins writing, so a value cached at boot is wrong from that moment until
/// the next reboot, which a failed install never reaches. The read costs less
/// than the status response's own jitter, so caching it buys nothing.
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
pub fn spawn_check(progress: Arc<OtaProgress>) -> Result<(), MutationError> {
    spawn(progress, Action::Check, None, None)
}

/// Kick off an install on a worker thread. The HTTP handler returns
/// immediately; callers poll [`OtaProgress::snapshot`] for status. A successful
/// install reboots the device into the new slot; the outcome is persisted in
/// `store` so it survives the reboot (and a possible rollback). The install
/// pauses `stream` while it runs — see [`quiesce_streaming`] — and resumes it
/// on failure.
pub fn spawn_update(
    progress: Arc<OtaProgress>,
    store: Arc<Mutex<ConfigStore>>,
    source: Source,
    stream: Option<Arc<StreamStatus>>,
) -> Result<(), MutationError> {
    spawn(progress, Action::Install(source), Some(store), stream)
}

fn spawn(
    progress: Arc<OtaProgress>,
    action: Action,
    store: Option<Arc<Mutex<ConfigStore>>>,
    stream: Option<Arc<StreamStatus>>,
) -> Result<(), MutationError> {
    progress.start(|| {
        let worker_progress = Arc::clone(&progress);
        let pending = task::prepare(
            ThreadSpawnConfiguration {
                name: Some(c"ota-update"),
                stack_size: WORKER_STACK_BYTES,
                ..Default::default()
            },
            move || {
                run(
                    &worker_progress,
                    action,
                    store.as_deref(),
                    stream.as_deref(),
                )
            },
        );
        match pending {
            Ok(worker) => {
                worker.commit();
                Ok(())
            }
            Err(error) => {
                let message = format!("cannot start OTA worker: {error:#}");
                Err(MutationError::Unavailable(message))
            }
        }
    })
}

fn run(
    progress: &OtaProgress,
    action: Action,
    store: Option<&Mutex<ConfigStore>>,
    stream: Option<&StreamStatus>,
) {
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
            stream,
        );
    }

    let current = env!("CARGO_PKG_VERSION");
    if let Err(error) = sync_clock(progress) {
        return progress.fail(error);
    }
    progress.set_message("checking latest release");
    let release = match update::check_release(
        || fetch_checksums().map_err(|error| format!("{error:#}")),
        || {
            progress.set_message("retrying release check; audio continues");
            esp_idf_svc::hal::delay::FreeRtos::delay_ms(1_000);
        },
    ) {
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
        stream,
    );
}

/// Pause streaming and wait until the network task closes the PCM connection,
/// freeing the socket and TLS buffers the download and flash writes need. A
/// device without a live pipeline passes through immediately; a transport that
/// will not release fails the install cleanly, keeping both firmware slots
/// intact.
fn quiesce_streaming(stream: Option<&StreamStatus>, progress: &OtaProgress) -> Result<(), String> {
    let Some(stream) = stream else { return Ok(()) };
    progress.set_message("pausing audio to install the update");
    stream.request_transport_quiesce();
    for _ in 0..QUIESCE_TIMEOUT_MS / QUIESCE_POLL_MS {
        if stream.transport_quiesced() {
            progress.set_message("audio paused while the update installs");
            return Ok(());
        }
        esp_idf_svc::hal::delay::FreeRtos::delay_ms(QUIESCE_POLL_MS);
    }
    stream.end_transport_quiesce();
    Err("audio streaming did not pause in time".to_owned())
}

fn sync_clock(progress: &OtaProgress) -> Result<(), String> {
    progress.set_message("synchronizing clock");
    time::wait_for_sync().map_err(|error| format!("time synchronization failed: {error:#}"))
}

/// Download, verify, and boot into the image at `url`; `what` is a non-sensitive
/// name for progress messages and persisted notes ("0.3.3", "custom image").
///
/// Streaming pauses for the duration and resumes if the install fails; a
/// successful install reboots, which resumes it in the new image.
fn install_and_reboot(
    url: &str,
    sha256: &str,
    what: &str,
    progress: &OtaProgress,
    store: Option<&Mutex<ConfigStore>>,
    stream: Option<&StreamStatus>,
) {
    if let Err(error) = quiesce_streaming(stream, progress) {
        let message = format!("install {what} failed: {error}");
        note_outcome(store, &message);
        return progress.fail(message);
    }
    progress.set_phase(Phase::Downloading);
    // Written before the download so a crash mid-install still leaves evidence;
    // overwritten by the final outcome below.
    note_outcome(store, &format!("installing {what} (did not finish)"));
    if let Err(error) = install(url, sha256, progress) {
        if let Some(stream) = stream {
            stream.end_transport_quiesce();
        }
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

fn download_url(asset: &str) -> String {
    format!("https://github.com/{REPO}/releases/latest/download/{asset}")
}

/// Fetch and parse the latest release's `SHA256SUMS` to learn the OTA image's
/// filename and expected digest.
fn fetch_checksums() -> Result<String> {
    let url = download_url("SHA256SUMS");
    // The check runs beside a live stream; per-record buffers keep it small.
    let mut response = HttpGet::get(&url, TlsRxBuffer::PerRecord)?;
    let status = response.status();
    if status != 200 {
        bail!("checksum fetch returned HTTP {status}");
    }

    let mut body = Vec::new();
    let mut chunk = [0_u8; 512];
    loop {
        let read = response.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
        if body.len() > MAX_SUMS_BYTES {
            bail!("checksum listing is implausibly large");
        }
    }

    let text = std::str::from_utf8(&body).context("checksum listing is not UTF-8")?;
    Ok(text.to_owned())
}

/// Stream the application image into the inactive slot, verifying its SHA-256
/// before committing the boot pointer.
///
/// The verifying-download logic lives in [`update::install_verified`]; this only
/// wires the HTTP response and the flash slot into it and commits or discards
/// the slot on the outcome.
fn install(url: &str, sha256: &str, progress: &OtaProgress) -> Result<()> {
    // Streaming is quiesced and the handshake just freed its burst: the held
    // receive buffer claims its one contiguous block at the best moment.
    let mut response = HttpGet::get(url, TlsRxBuffer::Held).context("download request failed")?;
    let status = response.status();
    if status != 200 {
        bail!("download returned HTTP {status}");
    }
    let total = response.content_length().unwrap_or(0) as u32;
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

/// Adapts an HTTP(S) response body to the byte source the installer reads from.
struct ResponseSource<'a>(&'a mut HttpGet);

impl ImageSource for ResponseSource<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, String> {
        self.0.read(buffer).map_err(|error| format!("{error:#}"))
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
