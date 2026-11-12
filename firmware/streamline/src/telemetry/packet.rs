//! Sampled capture, queue and send spans with SDK-owned W3C context.

use super::semconv::{
    SPAN_STREAMLINE_DEVICE_PACKET, SPAN_STREAMLINE_DEVICE_QUEUE, SPAN_STREAMLINE_DEVICE_SEND,
    STREAMLINE_PACKET_KIND, STREAMLINE_PACKET_SEQUENCE, STREAMLINE_TRIGGER,
};
use opentelemetry::{
    propagation::{Injector, TextMapPropagator},
    trace::{Span, Status, TraceContextExt, Tracer},
    Context, KeyValue,
};
use opentelemetry_sdk::{
    propagation::TraceContextPropagator,
    trace::{SdkTracer, Span as SdkSpan},
};
use std::time::{Instant, SystemTime};

#[derive(Clone, Copy)]
pub struct CaptureTime {
    pub wall: SystemTime,
    pub monotonic: Instant,
}

impl CaptureTime {
    pub fn now() -> Self {
        Self {
            wall: SystemTime::now(),
            monotonic: Instant::now(),
        }
    }
    fn current_wall(&self) -> SystemTime {
        self.wall + self.monotonic.elapsed()
    }
}

pub struct PacketTrace {
    root: SdkSpan,
    phase: Option<SdkSpan>,
    tracer: SdkTracer,
    time: CaptureTime,
    finished: bool,
}

impl PacketTrace {
    pub(super) fn new(
        tracer: &SdkTracer,
        sequence: u32,
        time: CaptureTime,
        silence: bool,
        trigger: &'static str,
    ) -> Self {
        let root = tracer
            .span_builder(SPAN_STREAMLINE_DEVICE_PACKET)
            .with_start_time(time.wall)
            .with_attributes([
                KeyValue::new(STREAMLINE_PACKET_SEQUENCE, i64::from(sequence)),
                KeyValue::new(
                    STREAMLINE_PACKET_KIND,
                    if silence { "silence" } else { "audio" },
                ),
                KeyValue::new(STREAMLINE_TRIGGER, trigger),
            ])
            .start_with_context(tracer, &Context::new());
        Self {
            root,
            phase: None,
            tracer: tracer.clone(),
            time,
            finished: false,
        }
    }

    fn context(&self) -> Context {
        Context::new().with_remote_span_context(self.root.span_context().clone())
    }

    pub fn traceparent(&self) -> String {
        #[derive(Default)]
        struct Carrier(String);
        impl Injector for Carrier {
            fn set(&mut self, key: &str, value: String) {
                if key == "traceparent" {
                    self.0 = value;
                }
            }
        }
        let mut carrier = Carrier::default();
        TraceContextPropagator::new().inject_context(&self.context(), &mut carrier);
        carrier.0
    }

    pub fn queued(&mut self) {
        self.phase(SPAN_STREAMLINE_DEVICE_QUEUE);
    }
    pub fn sending(&mut self) {
        self.phase(SPAN_STREAMLINE_DEVICE_SEND);
    }

    fn phase(&mut self, name: &'static str) {
        let at = self.time.current_wall();
        if let Some(mut previous) = self.phase.take() {
            previous.end_with_timestamp(at);
        }
        self.phase = Some(
            self.tracer
                .span_builder(name)
                .with_start_time(at)
                .start_with_context(&self.tracer, &self.context()),
        );
    }

    pub fn finish(mut self, sent: bool) {
        if !sent {
            self.error("packet batch failed or was cancelled");
        }
        self.end();
        self.finished = true;
    }

    fn error(&mut self, message: &'static str) {
        self.root.set_status(Status::error(message));
        if let Some(phase) = &mut self.phase {
            phase.set_status(Status::error(message));
        }
    }

    fn end(&mut self) {
        let at = self.time.current_wall();
        if let Some(mut phase) = self.phase.take() {
            phase.end_with_timestamp(at);
        }
        self.root.end_with_timestamp(at);
    }
}

impl Drop for PacketTrace {
    fn drop(&mut self) {
        if !self.finished {
            self.error("captured packet discarded before send completed");
            self.end();
        }
    }
}
