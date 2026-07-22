//! Host-testable capture-to-transport pipeline policy.
//!
//! The device [`crate::runtime`] wires I2S capture, FreeRTOS tasks, and the TCP
//! sender to these engines through the [`effects`] seams. Queue pressure,
//! signal gating, retry accounting, and the status counters live here, so the
//! latency and loss behavior is proven on the host rather than only on a board.

mod capture;
mod effects;
mod network;
mod queue;
mod status;

pub use capture::CaptureEngine;
pub use effects::{Clock, Delay, PacketSink, PcmSource, ReadFailed, SendFailed};
pub use network::run as run_network;
pub use queue::{PacketQueue, QUEUE_DEPTH};
pub use status::{StreamSnapshot, StreamStatus};
