//! Thin adapters around ESP-IDF services.
//!
//! `crate::config` owns the application data model. These modules only handle
//! persistence and hardware/runtime translation.

pub mod buttons;
pub mod captive_portal;
pub mod codec;
pub mod http;
pub mod i2s;
pub mod logs;
pub mod mdns;
pub mod nvs;
#[cfg(feature = "qemu")]
pub mod openeth;
pub mod ota;
pub mod pins;
pub mod status_light;
pub mod system;
pub mod tcp;
pub mod time;
pub mod wifi;
