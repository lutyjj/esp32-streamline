//! Endpoint registration grouped by API resource.

mod analog_passthrough;
pub(in crate::adapters) mod audio;
mod board;
mod buttons;
mod coredump;
mod leds;
mod logs;
mod ota;
mod settings;
mod status;
mod stream;
pub(in crate::adapters) mod system;
mod transport;

use anyhow::Result;

use super::ContractServer;

pub(super) fn register(server: &mut ContractServer<'_>) -> Result<()> {
    status::register(server)?;
    logs::register(server)?;
    coredump::register(server)?;
    settings::register_read(server)?;
    audio::register_read(server)?;
    board::register_read(server)?;
    system::register_contract(server)?;
    settings::register_network_writes(server)?;
    transport::register(server)?;
    board::register_write(server)?;
    audio::register_writes(server)?;
    analog_passthrough::register(server)?;
    leds::register(server)?;
    buttons::register(server)?;
    stream::register(server)?;
    settings::register_identity_writes(server)?;
    settings::register_firmware_write(server)?;
    ota::register(server)?;
    system::register_actions(server)
}
