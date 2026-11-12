//! Bounded SDK span admission and fallibly spawned export-worker ownership.

use opentelemetry::Context;
use opentelemetry_sdk::{
    error::OTelSdkResult,
    trace::{Span, SpanData, SpanExporter, SpanProcessor},
};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc::{Receiver, RecvTimeoutError, SyncSender},
        Arc,
    },
    time::{Duration, Instant},
};

pub const QUEUE_CAPACITY: usize = 8;
pub const BATCH_CAPACITY: usize = 4;

#[derive(Debug, Default)]
pub struct ExportHealth {
    pub running: AtomicBool,
    pub stop: AtomicBool,
    pub ended: AtomicU32,
    pub exported: AtomicU32,
    pub failed: AtomicU32,
    pub discarded: AtomicU32,
    pub failures: AtomicU32,
}

#[derive(Debug)]
pub struct QueuedSpans {
    pub sender: SyncSender<SpanData>,
    pub health: Arc<ExportHealth>,
}

impl SpanProcessor for QueuedSpans {
    fn on_start(&self, _: &mut Span, _: &Context) {}
    fn on_end(&self, span: SpanData) {
        self.health.ended.fetch_add(1, Ordering::Relaxed);
        if self.health.stop.load(Ordering::Acquire) || self.sender.try_send(span).is_err() {
            self.health.discarded.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn force_flush(&self) -> OTelSdkResult {
        // Delivery is asynchronous; a diagnostic caller observes export health.
        Err(opentelemetry_sdk::error::OTelSdkError::InternalFailure(
            "use session status to observe asynchronous export".into(),
        ))
    }
    fn shutdown_with_timeout(&self, _: Duration) -> OTelSdkResult {
        self.health.stop.store(true, Ordering::Release);
        Ok(())
    }
}

pub struct ExportJob<E: SpanExporter> {
    pub receiver: Receiver<SpanData>,
    pub exporter: E,
    pub health: Arc<ExportHealth>,
    pub deadline: Instant,
}

impl<E: SpanExporter> ExportJob<E> {
    pub fn run(self) {
        while !self.health.stop.load(Ordering::Acquire) && Instant::now() < self.deadline {
            let first = match self.receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(span) => span,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            };
            let mut batch = Vec::with_capacity(BATCH_CAPACITY);
            batch.push(first);
            batch.extend(self.receiver.try_iter().take(BATCH_CAPACITY - 1));
            let count = batch.len() as u32;
            if futures_executor::block_on(self.exporter.export(batch)).is_ok() {
                self.health.exported.fetch_add(count, Ordering::Relaxed);
            } else {
                self.health.failed.fetch_add(count, Ordering::Relaxed);
                self.health.failures.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl<E: SpanExporter> Drop for ExportJob<E> {
    fn drop(&mut self) {
        self.health.stop.store(true, Ordering::Release);
        self.health
            .discarded
            .fetch_add(self.receiver.try_iter().count() as u32, Ordering::Relaxed);
        let _ = self
            .exporter
            .shutdown_with_timeout(Duration::from_millis(500));
    }
}
