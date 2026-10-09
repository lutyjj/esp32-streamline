//! Bounded timing observations for the opt-in OpenTelemetry hardware experiment.

use opentelemetry::{
    trace::{Span, Status, Tracer, TracerProvider},
    KeyValue,
};
use opentelemetry_http::HttpClient;
use opentelemetry_otlp::{WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    trace::{IdGenerator, RandomIdGenerator, SdkTracerProvider},
    Resource,
};
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc::{Receiver, SyncSender},
        OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

static SENDER: OnceLock<SyncSender<Observation>> = OnceLock::new();
static DROPPED: AtomicU32 = AtomicU32::new(0);

#[derive(Clone, Copy)]
pub struct Sample {
    pub sequence: u32,
    pub wall: SystemTime,
    pub started: Instant,
}

impl Sample {
    pub fn capture(sequence: u32) -> Option<Self> {
        // Coprime with the four-packet send batch, so samples visit every position.
        (sequence % 257 == 0).then(|| Self {
            sequence,
            wall: SystemTime::now(),
            started: Instant::now(),
        })
    }
}

pub struct Observation {
    pub sample: Sample,
    pub queued: Duration,
    pub elapsed: Duration,
    pub sent: bool,
}

pub fn install(sender: SyncSender<Observation>) {
    let _ = SENDER.set(sender);
}

pub fn record(sample: Sample, queued: Duration, sent: bool) {
    if let Some(sender) = SENDER.get() {
        // Telemetry congestion must never delay the audio sender.
        if sender
            .try_send(Observation {
                sample,
                queued,
                elapsed: sample.started.elapsed(),
                sent,
            })
            .is_err()
        {
            DROPPED.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub fn export(
    receiver: Receiver<Observation>,
    endpoint: &str,
    client: impl HttpClient + 'static,
) -> anyhow::Result<()> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_http_client(client)
        .with_endpoint(endpoint)
        .with_timeout(Duration::from_millis(500))
        .build()?;
    let provider = SdkTracerProvider::builder()
        .with_resource(
            Resource::builder_empty()
                .with_service_name("streamline-device")
                .with_attributes([
                    KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
                    KeyValue::new(
                        "service.instance.id",
                        RandomIdGenerator::default().new_trace_id().to_string(),
                    ),
                ])
                .build(),
        )
        .with_simple_exporter(exporter)
        .build();
    let tracer = provider.tracer("streamline.audio");
    while let Ok(observation) = receiver.recv() {
        if crate::wall_clock::usable(observation.sample.wall) {
            emit(&tracer, observation);
        }
        let dropped = DROPPED.swap(0, Ordering::Relaxed);
        if dropped != 0 {
            log::warn!("telemetry queue discarded {dropped} samples");
        }
    }
    Ok(())
}

fn emit(tracer: &impl Tracer, observation: Observation) {
    let Observation {
        sample,
        queued,
        elapsed,
        sent,
    } = observation;
    let mut span = tracer
        .span_builder("streamline.device.packet")
        .with_start_time(sample.wall)
        .with_attributes([KeyValue::new(
            "streamline.packet.sequence",
            i64::from(sample.sequence),
        )])
        .start(tracer);
    span.add_event_with_timestamp("send.begin", sample.wall + queued, vec![]);
    if !sent {
        span.set_status(Status::error("packet batch not sent"));
    }
    span.end_with_timestamp(sample.wall + elapsed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_sdk::trace::InMemorySpanExporter;

    #[test]
    fn exports_measured_intervals_and_distinguishes_a_failed_send() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let tracer = provider.tracer("test");
        let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        emit(
            &tracer,
            Observation {
                sample: Sample {
                    sequence: 256,
                    wall,
                    started: Instant::now(),
                },
                queued: Duration::from_millis(12),
                elapsed: Duration::from_millis(15),
                sent: false,
            },
        );
        let spans = exporter.get_finished_spans().unwrap();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start_time, wall);
        assert_eq!(spans[0].end_time, wall + Duration::from_millis(15));
        assert_eq!(
            spans[0].events.events[0].timestamp,
            wall + Duration::from_millis(12)
        );
        assert_eq!(spans[0].status, Status::error("packet batch not sent"));
        assert_eq!(
            spans[0].attributes,
            vec![KeyValue::new("streamline.packet.sequence", 256_i64)]
        );
    }
}
