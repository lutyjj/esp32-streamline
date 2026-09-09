//! One-way restart handoff to a worker reserved before management starts.

use std::sync::{Condvar, Mutex};

#[derive(Default)]
pub struct Restart {
    pending: Mutex<bool>,
    ready: Condvar,
}

impl Restart {
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
    use std::sync::Arc;

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
