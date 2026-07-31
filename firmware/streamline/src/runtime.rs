//! Device task topology: pin the capture and network engines to core 1.

use core::ffi::CStr;
use std::{sync::Arc, thread};

use anyhow::{Context, Result};
use esp_idf_svc::hal::{cpu::Core, delay::FreeRtos, task::thread::ThreadSpawnConfiguration};

use crate::{
    adapters::{
        i2s::Capture,
        tcp::{TargetAddress, TcpClient},
    },
    stream::{self, CaptureEngine, Clock, Delay, PacketQueue, StreamStatus},
};

const TASK_STACK_BYTES: usize = 8_192;
/// The audio pipeline outranks every request-serving task: ESP-IDF httpd runs
/// at priority 5, and a burst of status scrapes must never starve capture or
/// the sender into dropping audio. Both engines block on I2S, the queue, or
/// the socket, so the elevated priority cannot monopolize the core.
const CAPTURE_PRIORITY: u8 = 7;
const NETWORK_PRIORITY: u8 = 6;

/// The FreeRTOS delay the engines back off with after a failure.
struct FreeRtosDelay;

impl Delay for FreeRtosDelay {
    fn delay_ms(&self, millis: u32) {
        FreeRtos::delay_ms(millis);
    }
}

/// Monotonic milliseconds for the network engine's send-stall accounting.
struct MonotonicClock(std::time::Instant);

impl Clock for MonotonicClock {
    fn monotonic_millis(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

/// Start capture unconditionally; stream to `target` only when one is
/// configured. Without a target the queue has no consumer, so none is created
/// and captured audio stops at level analysis — the meters and calibration
/// work before a bridge exists.
pub fn start(capture: Capture, target: Option<TargetAddress>) -> Result<Arc<StreamStatus>> {
    let status = Arc::new(StreamStatus::default());
    let queue = target.is_some().then(|| Arc::new(PacketQueue::new()));

    let capture_status = Arc::clone(&status);
    let capture_queue = queue.clone();
    spawn_pinned(c"capture", CAPTURE_PRIORITY, move || {
        CaptureEngine::new().run(capture, capture_queue, capture_status, FreeRtosDelay)
    })?;

    if let (Some(target), Some(queue)) = (target, queue) {
        // Recorded here, beside the decision itself: an install must wait for
        // this sender to release its buffers, and must not wait when there is
        // no sender to wait for.
        status.mark_transport_present();
        let network_status = Arc::clone(&status);
        spawn_pinned(c"network", NETWORK_PRIORITY, move || {
            stream::run_network(
                TcpClient::new(target),
                queue,
                network_status,
                FreeRtosDelay,
                MonotonicClock(std::time::Instant::now()),
            )
        })?;
    }
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
) -> Result<()> {
    ThreadSpawnConfiguration {
        name: Some(name),
        stack_size: TASK_STACK_BYTES,
        priority,
        pin_to_core: Some(Core::Core1),
        ..Default::default()
    }
    .set()
    .context("cannot configure streaming task")?;

    let spawned = thread::Builder::new()
        .stack_size(TASK_STACK_BYTES)
        .spawn(task)
        .context("cannot spawn streaming task");

    // Restore defaults so unrelated threads (e.g. the HTTP server) are unaffected.
    ThreadSpawnConfiguration::default()
        .set()
        .context("cannot restore default task configuration")?;

    spawned.map(drop)
}
