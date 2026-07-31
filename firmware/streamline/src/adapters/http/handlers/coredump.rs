//! Crash-dump handlers: status, image download, and erase.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    adapters::coredump::{self, CoredumpState},
    api,
};

use super::super::{
    auth::authorized_for,
    responses::{body_writer, json_response, not_found, unauthorized, unavailable},
    ApiState, ContractServer,
};

const NO_PARTITION: &str = "this flash layout has no coredump partition; a USB reflash adds it";

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    // Behind the admin key, like /api/logs: a dump is a copy of device memory
    // at the moment of the panic and can hold anything the firmware held.
    let state_for_status = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::COREDUMP, move |request| {
        if !authorized_for(&request, &state_for_status, api::COREDUMP) {
            return unauthorized(request);
        }
        match coredump::state() {
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
        }
    })?;

    let state_for_image = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::COREDUMP_IMAGE, move |request| {
        if !authorized_for(&request, &state_for_image, api::COREDUMP_IMAGE) {
            return unauthorized(request);
        }
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

    let state_for_erase = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::COREDUMP_ERASE, move |request| {
        if !authorized_for(&request, &state_for_erase, api::COREDUMP_ERASE) {
            return unauthorized(request);
        }
        match coredump::state() {
            CoredumpState::Unavailable => unavailable(request, NO_PARTITION),
            CoredumpState::Empty | CoredumpState::Present { .. } => {
                coredump::erase()?;
                json_response(request, 200, &api::Ack::ok())
            }
        }
    })
}
