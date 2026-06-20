//! Thin adapters around ESP-IDF services.
//!
//! `crate::config` owns the application data model. These modules only handle
//! persistence and hardware/runtime translation.

pub mod nvs;
