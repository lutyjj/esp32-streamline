#![forbid(unsafe_code)]

//! Hardware-independent StreamLine application model.
//!
//! ESP-IDF adapters live in the binary crate. Keeping protocol, configuration,
//! lifecycle policy, and telemetry here makes them host-testable and prevents
//! board/runtime concerns from leaking into application logic.

pub mod config;
pub mod mode;
pub mod protocol;
pub mod telemetry;
