//! Crash-dump handlers: status, image download, and erase.

use anyhow::Result;

use crate::{
    adapters::coredump::{self, CoredumpState},
    api,
};

use super::super::{
    responses::{body_writer, json_response, not_found, unavailable},
    ContractServer,
};

const NO_PARTITION: &str = "this flash layout has no coredump partition; a USB reflash adds it";

pub(super) fn register(server: &mut ContractServer<'_>) -> Result<()> {
    // Behind the admin key, like /api/logs: a dump is a copy of device memory
    // at the moment of the panic and can hold anything the firmware held.
    server.handler(api::COREDUMP, move |request| match coredump::state() {
        CoredumpState::Unavailable => unavailable(request, NO_PARTITION),
        CoredumpState::Empty => json_response(
            request,
            200,
            &api::CoredumpResponse {
                present: false,
                size_bytes: 0,
            },
        ),
        CoredumpState::Present { size_bytes } => json_response(
            request,
            200,
            &api::CoredumpResponse {
                present: true,
                size_bytes,
            },
        ),
    })?;

    server.handler(api::COREDUMP_IMAGE, move |request| {
        match coredump::state() {
            CoredumpState::Unavailable => unavailable(request, NO_PARTITION),
            CoredumpState::Empty => not_found(request, "no crash dump is stored"),
            CoredumpState::Present { .. } => {
                let mut writer = body_writer(request, 200, "application/octet-stream")?;
                coredump::read_image(|chunk| {
                    std::io::Write::write_all(&mut writer, chunk).map_err(Into::into)
                })?;
                std::io::Write::flush(&mut writer)?;
                Ok(())
            }
        }
    })?;

    server.handler(api::COREDUMP_ERASE, move |request| {
        match coredump::state() {
            CoredumpState::Unavailable => unavailable(request, NO_PARTITION),
            CoredumpState::Empty | CoredumpState::Present { .. } => {
                coredump::erase()?;
                json_response(request, 200, &api::Ack::ok())
            }
        }
    })
}
