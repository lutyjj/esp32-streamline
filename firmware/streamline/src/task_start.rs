//! Reserve worker resources before committing a multi-task startup.

use std::{io, sync::mpsc, thread};

pub struct PendingTask {
    start: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl PendingTask {
    pub fn spawn(
        builder: thread::Builder,
        task: impl FnOnce() + Send + 'static,
    ) -> io::Result<Self> {
        let (start, ready) = mpsc::channel();
        let worker = builder.spawn(move || {
            if ready.recv().is_ok() {
                task();
            }
        })?;
        Ok(Self {
            start: Some(start),
            worker: Some(worker),
        })
    }

    pub fn commit(mut self) {
        self.start
            .take()
            .expect("pending task")
            .send(())
            .expect("waiting worker");
        self.worker.take();
    }
}

impl Drop for PendingTask {
    fn drop(&mut self) {
        self.start.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    #[test]
    fn cancelled_start_releases_resources_without_running() {
        let ran = Arc::new(AtomicBool::new(false));
        let owned = Arc::clone(&ran);
        let pending = PendingTask::spawn(thread::Builder::new(), move || {
            owned.store(true, Ordering::SeqCst);
        })
        .unwrap();
        assert!(!ran.load(Ordering::SeqCst));
        drop(pending);
        assert!(!ran.load(Ordering::SeqCst));
        assert_eq!(Arc::strong_count(&ran), 1);
    }

    #[test]
    fn committed_start_runs_the_worker() {
        let (send, receive) = mpsc::channel();
        let pending =
            PendingTask::spawn(thread::Builder::new(), move || send.send(7).unwrap()).unwrap();
        assert!(receive.try_recv().is_err());
        pending.commit();
        assert_eq!(receive.recv().unwrap(), 7);
    }
}
