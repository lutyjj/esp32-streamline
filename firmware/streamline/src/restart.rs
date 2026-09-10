//! One-way restart handoff to a worker reserved before management starts.

use std::sync::{Condvar, Mutex};

#[derive(Default)]
pub struct Restart {
    pending: Mutex<bool>,
    ready: Condvar,
}

impl Restart {
    /// Admit an automatic restart only while no OTA worker or restart owns the
    /// device. OTA admission must use the same control mutex. `prepare` runs
    /// under that mutex, so it must not call the management HTTP server.
    pub fn request_when_idle<E>(
        &self,
        control: &Mutex<()>,
        ota: &crate::update::progress::OtaProgress,
        prepare: impl FnOnce() -> Result<(), E>,
    ) -> Result<bool, E> {
        let _control = control.lock().expect("control lock poisoned");
        if self.is_pending() || ota.snapshot().busy {
            return Ok(false);
        }
        prepare()?;
        self.request();
        Ok(true)
    }

    pub fn request(&self) {
        *self.pending.lock().expect("restart lock poisoned") = true;
        self.ready.notify_one();
    }

    pub fn is_pending(&self) -> bool {
        *self.pending.lock().expect("restart lock poisoned")
    }

    pub fn wait(&self) {
        drop(
            self.ready
                .wait_while(
                    self.pending.lock().expect("restart lock poisoned"),
                    |pending| !*pending,
                )
                .expect("restart lock poisoned"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::progress::{OtaProgress, Phase};
    use std::sync::Arc;

    #[test]
    fn automatic_restart_defers_to_every_active_ota_phase() {
        for phase in [
            Phase::Checking,
            Phase::Downloading,
            Phase::Verifying,
            Phase::Installed,
        ] {
            let restart = Restart::default();
            let ota = OtaProgress::default();
            ota.set_phase(phase);
            assert_eq!(
                restart.request_when_idle(&Mutex::new(()), &ota, || -> Result<(), ()> {
                    panic!("active OTA must prevent slot confirmation");
                }),
                Ok(false)
            );
            assert!(!restart.is_pending());
        }
    }

    #[test]
    fn confirmation_and_restart_reservation_hold_the_control_lock() {
        let control = Mutex::new(());
        let restart = Restart::default();
        let ota = OtaProgress::default();
        assert_eq!(
            restart.request_when_idle(&control, &ota, || {
                assert!(control.try_lock().is_err());
                assert!(!restart.is_pending());
                Ok::<(), ()>(())
            }),
            Ok(true)
        );
        assert!(restart.is_pending());
        assert!(control.try_lock().is_ok());
        assert_eq!(
            restart.request_when_idle(&control, &ota, || Err("must not run")),
            Ok(false)
        );
    }

    #[test]
    fn failed_confirmation_leaves_restart_available_for_retry() {
        let control = Mutex::new(());
        let restart = Restart::default();
        let ota = OtaProgress::default();
        assert_eq!(
            restart.request_when_idle(&control, &ota, || Err("flash failure")),
            Err("flash failure")
        );
        assert!(!restart.is_pending());
        assert_eq!(
            restart.request_when_idle(&control, &ota, || Ok::<(), ()>(())),
            Ok(true)
        );
    }

    #[test]
    fn request_survives_a_late_worker_and_cannot_be_cancelled() {
        let restart = Restart::default();
        assert!(!restart.is_pending());
        restart.request();
        restart.wait();
        assert!(restart.is_pending());
        restart.request();
        assert!(restart.is_pending());
    }

    #[test]
    fn request_wakes_the_reserved_worker() {
        let restart = Arc::new(Restart::default());
        let worker_restart = Arc::clone(&restart);
        let worker = std::thread::spawn(move || worker_restart.wait());
        restart.request();
        worker.join().unwrap();
        assert!(restart.is_pending());
    }
}
