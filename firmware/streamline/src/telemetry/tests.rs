//! Session lifecycle and packet context contracts without hardware or sockets.

use super::*;
use crate::{
    packet::AudioPacket,
    protocol::{HEADER_LEN, PAYLOAD_BYTES, TRACED_HEADER_LEN},
};
use opentelemetry::{
    propagation::TextMapPropagator,
    trace::{Status, TraceContextExt},
};
use opentelemetry_sdk::{propagation::TraceContextPropagator, trace::InMemorySpanExporter};
use std::time::SystemTime;

fn request() -> SessionRequest {
    SessionRequest {
        endpoint: "http://192.0.2.1:4318/v1/traces".into(),
        duration_seconds: 60,
        allow_insecure: true,
        bearer_token: String::new(),
        ca_certificate_pem: String::new(),
    }
}

#[test]
fn packet_wire_context_matches_sdk_spans_and_preserves_pcm() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let tracer = provider.tracer("test");
    let wall = SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let mut trace = PacketTrace::new(
        &tracer,
        12,
        CaptureTime {
            wall,
            monotonic: Instant::now() - Duration::from_millis(20),
        },
        false,
        "periodic",
    );
    trace.queued();
    let mut packet = AudioPacket::from_pcm(12, &[0x55; PAYLOAD_BYTES]);
    packet.trace = Some(Box::new(trace));
    let mut wire = Vec::new();
    packet.append_wire(&mut wire);
    assert_eq!(wire[5] as usize, TRACED_HEADER_LEN);
    assert_eq!(&wire[TRACED_HEADER_LEN..], &[0x55; PAYLOAD_BYTES]);
    let carrier = std::collections::HashMap::from([(
        "traceparent".to_owned(),
        String::from_utf8(wire[HEADER_LEN..TRACED_HEADER_LEN].to_vec()).unwrap(),
    )]);
    let parent = TraceContextPropagator::new().extract(&carrier);
    let mut trace = packet.trace.take().unwrap();
    trace.sending();
    trace.finish(false);
    let spans = exporter.get_finished_spans().unwrap();
    assert_eq!(spans.len(), 3);
    let root = spans
        .iter()
        .find(|span| span.name == semconv::SPAN_STREAMLINE_DEVICE_PACKET)
        .unwrap();
    assert_eq!(
        root.span_context.trace_id(),
        parent.span().span_context().trace_id()
    );
    assert_eq!(
        root.span_context.span_id(),
        parent.span().span_context().span_id()
    );
    assert_eq!(root.start_time, wall);
    assert!(root.end_time.duration_since(wall).unwrap() >= Duration::from_millis(20));
    assert!(matches!(root.status, Status::Error { .. }));
    for child in spans
        .iter()
        .filter(|span| span.name != semconv::SPAN_STREAMLINE_DEVICE_PACKET)
    {
        assert_eq!(child.parent_span_id, root.span_context.span_id());
    }
}

#[test]
fn congestion_and_abandoned_packets_are_bounded_and_accounted() {
    let manager = Telemetry::default();
    assert!(manager
        .capture(0, CaptureTime::now(), false, None)
        .is_none());
    let (session, job) = Session::prepare(
        &request(),
        manager.resource(),
        InMemorySpanExporter::default(),
    );
    manager.install(Arc::clone(&session));
    assert!(manager.can_start().is_err());
    for sequence in 0..20 {
        let mut trace = manager
            .capture(sequence, CaptureTime::now(), false, Some("source_onset"))
            .unwrap();
        trace.queued();
        drop(trace);
    }
    let status = manager.snapshot();
    assert_eq!(status.ended_spans, 40);
    assert_eq!(status.discarded_spans, 32);
    assert_eq!(status.pending_spans, 8);
    manager.stop();
    assert!(manager
        .capture(257, CaptureTime::now(), false, None)
        .is_none());
    job.run();
    session.release_sdk();
    let status = manager.snapshot();
    assert!(matches!(status.state, SessionState::Finished));
    assert_eq!(status.discarded_spans, status.ended_spans);
    assert_eq!(status.pending_spans, 0);
    assert!(session.sdk.lock().unwrap().is_none());
    assert!(manager.can_start().is_ok());
}

#[test]
fn expiry_and_an_unset_clock_stop_admission() {
    let manager = Telemetry::default();
    let mut config = request();
    config.duration_seconds = 0;
    assert!(config.validate().is_err());
    let (session, job) =
        Session::prepare(&config, manager.resource(), InMemorySpanExporter::default());
    manager.install(Arc::clone(&session));
    assert!(manager
        .capture(0, CaptureTime::now(), false, None)
        .is_none());
    job.run();
    session.release_sdk();
    let (session, job) = Session::prepare(
        &request(),
        manager.resource(),
        InMemorySpanExporter::default(),
    );
    manager.install(Arc::clone(&session));
    assert!(manager
        .capture(
            0,
            CaptureTime {
                wall: SystemTime::UNIX_EPOCH,
                monotonic: Instant::now()
            },
            false,
            None
        )
        .is_none());
    assert!(manager
        .capture(1, CaptureTime::now(), false, None)
        .is_some());
    assert!(manager
        .capture(2, CaptureTime::now(), false, None)
        .is_none());
    assert!(manager
        .capture(257, CaptureTime::now(), false, None)
        .is_some());
    manager.stop();
    drop(job);
    session.release_sdk();
}
