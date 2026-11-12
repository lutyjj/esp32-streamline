//! Runtime diagnostic sessions over the standard OpenTelemetry SDK.

pub mod config;
pub mod export;
mod packet;
pub mod semconv;
#[cfg(test)]
mod tests;
use semconv::{STREAMLINE_CLOCK_ALIGNED, STREAMLINE_SAMPLE_INTERVAL};

pub use config::SessionRequest;
pub use packet::{CaptureTime, PacketTrace};

use crate::mutation::MutationError;
use export::{ExportHealth, ExportJob, QueuedSpans, QUEUE_CAPACITY};
use opentelemetry::{trace::TracerProvider, KeyValue};
use opentelemetry_sdk::{
    trace::{IdGenerator, RandomIdGenerator, SdkTracer, SdkTracerProvider, SpanExporter},
    Resource,
};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::sync_channel,
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[cfg_attr(feature = "api-spec", schema(example = json!(crate::api::examples::telemetry())))]
pub struct TelemetryStatus {
    pub state: SessionState,
    pub remaining_seconds: u32,
    pub sample_interval_packets: u32,
    pub ended_spans: u32,
    pub exported_spans: u32,
    pub failed_spans: u32,
    pub discarded_spans: u32,
    pub export_failures: u32,
    pub pending_spans: u32,
    pub wall_clock_ready: bool,
    /// Cross-host clock offset is not measured; only local durations are authoritative.
    pub cross_host_clock_aligned: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Disabled,
    Running,
    Stopping,
    Finished,
}

pub struct Session {
    // Retains the SDK provider for every span created by this session.
    sdk: Mutex<Option<(SdkTracerProvider, SdkTracer)>>,
    health: Arc<ExportHealth>,
    deadline: Instant,
    first: AtomicBool,
}

impl Session {
    pub fn prepare<E: SpanExporter>(
        config: &SessionRequest,
        resource: Resource,
        mut exporter: E,
    ) -> (Arc<Self>, ExportJob<E>) {
        let health = Arc::new(ExportHealth::default());
        health.running.store(true, Ordering::Release);
        let deadline = Instant::now() + Duration::from_secs(u64::from(config.duration_seconds));
        let (sender, receiver) = sync_channel(QUEUE_CAPACITY);
        exporter.set_resource(&resource);
        let provider = SdkTracerProvider::builder()
            .with_resource(resource)
            .with_span_processor(QueuedSpans {
                sender,
                health: Arc::clone(&health),
            })
            .build();
        let tracer = provider.tracer("streamline.audio");
        let session = Arc::new(Self {
            sdk: Mutex::new(Some((provider, tracer))),
            health: Arc::clone(&health),
            deadline,
            first: AtomicBool::new(true),
        });
        (
            session,
            ExportJob {
                receiver,
                exporter,
                health,
                deadline,
            },
        )
    }

    fn recording(&self) -> bool {
        self.health.running.load(Ordering::Acquire)
            && !self.health.stop.load(Ordering::Acquire)
            && Instant::now() < self.deadline
    }

    pub fn release_sdk(&self) {
        self.sdk.lock().expect("telemetry SDK poisoned").take();
        self.health.running.store(false, Ordering::Release);
    }
}

pub struct Telemetry {
    enabled: AtomicBool,
    session: Mutex<Option<Arc<Session>>>,
    instance: String,
}

impl Default for Telemetry {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            session: Mutex::new(None),
            instance: RandomIdGenerator::default().new_trace_id().to_string(),
        }
    }
}

impl Telemetry {
    pub fn resource(&self) -> Resource {
        Resource::builder_empty()
            .with_service_name("streamline-device")
            .with_attributes([
                KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                KeyValue::new("service.instance.id", self.instance.clone()),
                KeyValue::new(
                    STREAMLINE_SAMPLE_INTERVAL,
                    i64::from(config::SAMPLE_INTERVAL),
                ),
                KeyValue::new(STREAMLINE_CLOCK_ALIGNED, false),
            ])
            .build()
    }

    pub fn can_start(&self) -> Result<(), MutationError> {
        if self
            .session
            .lock()
            .expect("telemetry session poisoned")
            .as_ref()
            .is_some_and(|s| s.health.running.load(Ordering::Acquire))
        {
            Err(MutationError::Conflict(
                "a telemetry session is running or stopping".into(),
            ))
        } else {
            Ok(())
        }
    }

    /// The adapter serializes control operations and reserves the worker before publication.
    pub fn install(&self, session: Arc<Session>) {
        *self.session.lock().expect("telemetry session poisoned") = Some(session);
        self.enabled.store(true, Ordering::Release);
    }

    pub fn stop(&self) {
        self.enabled.store(false, Ordering::Release);
        if let Some(session) = self
            .session
            .lock()
            .expect("telemetry session poisoned")
            .as_ref()
        {
            session.health.stop.store(true, Ordering::Release);
        }
    }

    pub fn capture(
        &self,
        sequence: u32,
        time: CaptureTime,
        silence: bool,
        trigger: Option<&'static str>,
    ) -> Option<Box<PacketTrace>> {
        if !self.enabled.load(Ordering::Acquire) {
            return None;
        }
        let session = self
            .session
            .lock()
            .expect("telemetry session poisoned")
            .clone()?;
        if !session.recording() || !crate::wall_clock::usable(time.wall) {
            return None;
        }
        let first = session.first.swap(false, Ordering::Relaxed);
        if !first && trigger.is_none() && sequence % config::SAMPLE_INTERVAL != 0 {
            return None;
        }
        let sdk = session.sdk.lock().expect("telemetry SDK poisoned");
        let (_, tracer) = sdk.as_ref()?;
        Some(Box::new(PacketTrace::new(
            tracer,
            sequence,
            time,
            silence,
            if first {
                "session_start"
            } else {
                trigger.unwrap_or("periodic")
            },
        )))
    }

    pub fn snapshot(&self) -> TelemetryStatus {
        let current = self.session.lock().expect("telemetry session poisoned");
        let mut status = TelemetryStatus {
            state: SessionState::Disabled,
            remaining_seconds: 0,
            sample_interval_packets: config::SAMPLE_INTERVAL,
            ended_spans: 0,
            exported_spans: 0,
            failed_spans: 0,
            discarded_spans: 0,
            export_failures: 0,
            pending_spans: 0,
            wall_clock_ready: crate::wall_clock::usable(std::time::SystemTime::now()),
            cross_host_clock_aligned: false,
        };
        if let Some(session) = current.as_ref() {
            let health = &session.health;
            let running = health.running.load(Ordering::Acquire);
            status.state = if !running {
                SessionState::Finished
            } else if session.recording() {
                SessionState::Running
            } else {
                SessionState::Stopping
            };
            status.remaining_seconds = session
                .deadline
                .saturating_duration_since(Instant::now())
                .as_secs() as u32;
            status.ended_spans = health.ended.load(Ordering::Relaxed);
            status.exported_spans = health.exported.load(Ordering::Relaxed);
            status.failed_spans = health.failed.load(Ordering::Relaxed);
            status.discarded_spans = if running {
                health.discarded.load(Ordering::Relaxed)
            } else {
                status
                    .ended_spans
                    .saturating_sub(status.exported_spans)
                    .saturating_sub(status.failed_spans)
            };
            status.export_failures = health.failures.load(Ordering::Relaxed);
            status.pending_spans = status
                .ended_spans
                .saturating_sub(status.exported_spans)
                .saturating_sub(status.failed_spans)
                .saturating_sub(status.discarded_spans);
        }
        status
    }
}
