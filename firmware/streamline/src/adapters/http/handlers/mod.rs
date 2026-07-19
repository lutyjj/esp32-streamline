//! Endpoint registration grouped by API resource.

mod analog_passthrough;
pub(in crate::adapters) mod audio;
mod board;
mod buttons;
mod leds;
mod ota;
mod settings;
mod status;
mod stream;
mod system;
mod transport;

use std::sync::Arc;

use anyhow::Result;

use super::{ApiState, ContractServer};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    status::register(server, state)?;
    settings::register_read(server, state)?;
    audio::register_read(server, state)?;
    board::register_read(server, state)?;
    system::register_contract(server)?;
    settings::register_network_writes(server, state)?;
    transport::register(server, state)?;
    board::register_write(server, state)?;
    audio::register_writes(server, state)?;
    analog_passthrough::register(server, state)?;
    leds::register(server, state)?;
    buttons::register(server, state)?;
    stream::register(server, state)?;
    settings::register_identity_writes(server, state)?;
    settings::register_firmware_write(server, state)?;
    ota::register(server, state)?;
    system::register_actions(server, state)
}
