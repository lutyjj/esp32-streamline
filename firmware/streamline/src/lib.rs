#![deny(unsafe_op_in_unsafe_fn)]

//! Hardware-independent StreamLine application model.
//!
//! ESP-IDF adapters live in the binary crate. Keeping protocol and
//! configuration here makes them host-testable and prevents board/runtime
//! concerns from leaking into application logic.

pub mod board;
pub mod config;
#[cfg(any(test, target_os = "espidf"))]
mod counter;
pub mod health;
pub mod identity;
pub mod levels;
pub mod metrics;
pub mod packet;
pub mod play;
pub mod protocol;
pub mod telemetry;
pub mod update;

#[cfg(target_os = "espidf")]
pub mod adapters;
#[cfg(target_os = "espidf")]
pub mod runtime;
