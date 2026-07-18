//! Device HTTP contract.
//!
//! Route metadata and wire DTOs are defined here so the firmware adapter, the
//! generated OpenAPI document, and the generated console types all derive from
//! Rust types the device actually serializes and deserializes. The contract is
//! split into its route table (`endpoints`), the request DTOs the device
//! accepts (`requests`), and the response DTOs it returns (`responses`).

mod endpoints;
#[cfg(feature = "api-spec")]
pub mod examples;
mod requests;
mod responses;

pub use endpoints::*;
pub use requests::*;
pub use responses::*;
