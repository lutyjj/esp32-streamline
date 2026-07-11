#![deny(unsafe_op_in_unsafe_fn)]

//! Hardware-independent StreamLine application model.
//!
//! ESP-IDF adapters compile only for the device target. Keeping protocol and
//! configuration in target-independent modules makes them host-testable and
//! prevents board/runtime concerns from leaking into application logic.

pub mod api;
pub mod board;
pub mod config;
#[cfg(any(test, target_os = "espidf"))]
mod counter;
pub mod health;
pub mod identity;
pub mod indicator;
pub mod levels;
pub mod metrics;
pub mod packet;
pub mod play;
pub mod profiles;
pub mod protocol;
pub mod telemetry;
pub mod update;

#[cfg(target_os = "espidf")]
pub mod adapters;
#[cfg(target_os = "espidf")]
pub mod runtime;
