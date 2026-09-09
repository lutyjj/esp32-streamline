//! Device task topology: pin the capture and network engines to core 1.

use core::ffi::CStr;
use std::sync::Arc;

use anyhow::Result;
use esp_idf_svc::hal::{cpu::Core, delay::FreeRtos, task::thread::ThreadSpawnConfiguration};

use crate::{
    adapters::{
        i2s::Capture,
        task,
        tcp::{TargetAddress, TcpClient},
    },
    stream::{self, CaptureEngine, Clock, Delay, PacketQueue, StreamStatus},
    task_start::PendingTask,
};

const TASK_STACK_BYTES: usize = 8_192;
/// The audio pipeline outranks every request-serving task: ESP-IDF httpd runs
/// at priority 5, and a burst of status scrapes must never starve capture or
/// the sender into dropping audio. Both engines block on I2S, the queue, or
/// the socket, so the elevated priority cannot monopolize the core.
const CAPTURE_PRIORITY: u8 = 7;
const NETWORK_PRIORITY: u8 = 6;

#[derive(Clone, Copy)]
struct SystemClock(std::time::Instant);

impl Delay for SystemClock {
    fn delay_ms(&self, millis: u32) {
        FreeRtos::delay_ms(millis);
    }
}

impl Clock for SystemClock {
    fn monotonic_millis(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

/// Start capture unconditionally; stream to `target` only when one is
/// configured. Without a target the queue has no consumer, so none is created
/// and captured audio stops at level analysis — the meters and calibration
/// work before a bridge exists.
pub fn start(capture: Capture, target: Option<TargetAddress>) -> Result<Arc<StreamStatus>> {
    #[cfg(feature = "test-source")]
    let capture = stream::test_source::TestSource::new(capture);
    let status = Arc::new(StreamStatus::default());
    let queue = target.is_some().then(|| Arc::new(PacketQueue::new()));

    let clock = SystemClock(std::time::Instant::now());
    let capture_status = Arc::clone(&status);
    let capture_queue = queue.clone();
    let capture_task = spawn_pinned(c"capture", CAPTURE_PRIORITY, move || {
        CaptureEngine::new(Capture::BUFFERED_FRAMES).run(
            capture,
            capture_queue,
            capture_status,
            clock,
        )
    })?;

    if let (Some(target), Some(queue)) = (target, queue) {
        // Recorded here, beside the decision itself: an install must wait for
        // this sender to release its buffers, and must not wait when there is
        // no sender to wait for.
        status.mark_transport_present();
        let network_status = Arc::clone(&status);
        let network_task = spawn_pinned(c"network", NETWORK_PRIORITY, move || {
            stream::run_network(TcpClient::new(target), queue, network_status, clock, clock)
        })?;
        network_task.commit();
    }
    capture_task.commit();
    Ok(status)
}

/// Spawn a real-time task pinned to the application core. `std::thread` on
/// ESP-IDF is backed by FreeRTOS tasks; [`ThreadSpawnConfiguration`] supplies
/// the name, priority, and core affinity the raw FreeRTOS API would otherwise
/// require unsafe FFI to set.
fn spawn_pinned(
    name: &'static CStr,
    priority: u8,
    task: impl FnOnce() + Send + 'static,
) -> Result<PendingTask> {
    task::prepare(
        ThreadSpawnConfiguration {
            name: Some(name),
            stack_size: TASK_STACK_BYTES,
            priority,
            pin_to_core: Some(Core::Core1),
            ..Default::default()
        },
        task,
    )
}
