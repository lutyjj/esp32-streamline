//! OTA worker reservation and observable progress.

use crate::mutation::MutationError;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicU32, AtomicU8, Ordering},
    Mutex,
};

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
    fn is_busy(self) -> bool {
        matches!(
            self,
            Self::Checking | Self::Downloading | Self::Verifying | Self::Installed
        )
    }

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
    pub fn start(
        &self,
        start: impl FnOnce() -> Result<(), MutationError>,
    ) -> Result<(), MutationError> {
        if !self.begin() {
            return Err(MutationError::Conflict(
                "an update is already in progress".into(),
            ));
        }
        if let Err(error) = start() {
            self.fail(error.to_string());
            return Err(error);
        }
        Ok(())
    }
    pub fn snapshot(&self) -> OtaSnapshot {
        let phase = Phase::from_u8(self.phase.load(Ordering::Relaxed));
        let detail = self.detail.lock().expect("ota detail lock poisoned");
        OtaSnapshot {
            phase: phase.as_str(),
            bytes_written: self.written.load(Ordering::Relaxed),
            bytes_total: self.total.load(Ordering::Relaxed),
            latest_version: detail.latest_version.clone(),
            message: detail.message.clone(),
            busy: phase.is_busy(),
        }
    }

    /// Reserve the worker: returns `false` if an update is already running.
    /// Compare-and-swap on the phase makes the reservation atomic, so two
    /// concurrent trigger requests can never both start a worker.
    fn begin(&self) -> bool {
        let mut current = self.phase.load(Ordering::Relaxed);
        loop {
            if Phase::from_u8(current).is_busy() {
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
        self.set_latest("");
        true
    }

    pub fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Relaxed);
    }

    pub fn set_progress(&self, written: u32, total: u32) {
        self.written.store(written, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
    }

    pub fn set_latest(&self, version: &str) {
        self.detail
            .lock()
            .expect("ota detail lock poisoned")
            .latest_version = version.to_owned();
    }

    pub fn set_message(&self, message: &str) {
        self.detail
            .lock()
            .expect("ota detail lock poisoned")
            .message = message.to_owned();
    }

    pub fn fail(&self, message: String) {
        log::warn!("OTA update failed: {message}");
        self.set_message(&message);
        self.set_phase(Phase::Failed);
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_start_is_visible_and_can_be_retried() {
        let progress = OtaProgress::default();
        progress.set_latest("9.0.0");
        let error = MutationError::Unavailable("cannot reserve task".into());
        assert_eq!(progress.start(|| Err(error.clone())), Err(error));
        let snapshot = progress.snapshot();
        assert_eq!(snapshot.phase, "failed");
        assert!(!snapshot.busy);
        assert_eq!(snapshot.message, "cannot reserve task");
        assert!(snapshot.latest_version.is_empty());
        progress.start(|| Ok(())).unwrap();
        assert!(progress.snapshot().busy);
    }

    #[test]
    fn concurrent_start_is_a_conflict_and_preserves_the_owner() {
        let progress = OtaProgress::default();
        progress.start(|| Ok(())).unwrap();
        assert!(matches!(
            progress.start(|| panic!("second worker")),
            Err(MutationError::Conflict(_))
        ));
        assert_eq!(progress.snapshot().phase, "checking");
    }

    #[test]
    fn installed_image_keeps_the_worker_reserved_until_reboot() {
        let progress = OtaProgress::default();
        progress.start(|| Ok(())).unwrap();
        progress.set_progress(1024, 1024);
        progress.set_latest("9.0.0");
        progress.set_message("Rebooting into the installed image");
        progress.set_phase(Phase::Installed);

        assert!(matches!(
            progress.start(|| panic!("another worker started before reboot")),
            Err(MutationError::Conflict(_))
        ));
        let snapshot = progress.snapshot();
        assert!(snapshot.busy);
        assert_eq!(snapshot.phase, "installed");
        assert_eq!((snapshot.bytes_written, snapshot.bytes_total), (1024, 1024));
        assert_eq!(snapshot.latest_version, "9.0.0");
        assert_eq!(snapshot.message, "Rebooting into the installed image");
    }

    #[test]
    fn completed_checks_release_the_worker_for_another_request() {
        let progress = OtaProgress::default();
        for phase in [Phase::UpToDate, Phase::UpdateAvailable] {
            progress.start(|| Ok(())).unwrap();
            progress.set_phase(phase);
            assert!(!progress.snapshot().busy);
        }
        progress.start(|| Ok(())).unwrap();
    }
}
