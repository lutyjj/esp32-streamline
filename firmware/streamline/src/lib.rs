#![deny(unsafe_op_in_unsafe_fn)]

//! Hardware-independent StreamLine application model.
//!
//! ESP-IDF adapters live in the binary crate. Keeping protocol and
//! configuration here makes them host-testable and prevents board/runtime
//! concerns from leaking into application logic.

pub mod config;
pub mod levels;
pub mod packet;
pub mod protocol;

#[cfg(target_os = "espidf")]
pub mod adapters;
#[cfg(target_os = "espidf")]
pub mod runtime;
