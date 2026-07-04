//! Thin adapters around ESP-IDF services.
//!
//! `crate::config` owns the application data model. These modules only handle
//! persistence and hardware/runtime translation.

pub mod codec;
pub mod http;
pub mod i2s;
pub mod mdns;
pub mod nvs;
pub mod ota;
pub mod tcp;
pub mod time;
pub mod wifi;
