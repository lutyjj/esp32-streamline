//! API contract, authentication check, restart, and factory-reset handlers.

use anyhow::Result;

use crate::{
    adapters::coredump::{self, CoredumpState},
    api,
    mutation::MutationError,
};

use super::super::{
    responses::{
        json_response, mutation_error, reboot_response, reboot_response_with, respond_gzip,
    },
    ApiState, ContractServer, OPENAPI_GZ,
};

pub(super) fn register_contract(server: &mut ContractServer<'_>) -> Result<()> {
    server.handler(api::OPENAPI, move |request, _| {
        respond_gzip(request, 200, "application/json", OPENAPI_GZ)
    })
}

pub(super) fn register_actions(server: &mut ContractServer<'_>) -> Result<()> {
    // Verify an admin key without changing anything — the route table's
    // authentication gate does all the work — so the console can reject a
    // wrong key at unlock time instead of on the first settings write.
    server.handler(api::UNLOCK, move |request, _| {
        json_response(request, 200, &api::Ack::ok())
    })?;

    // Plain reboot with settings intact; recovers a wedged stream without a
    // trip to the power plug. The wrapping closure supplies the higher-ranked
    // connection lifetime `handler` demands, which the bare function item
    // cannot satisfy.
    server.handler(api::RESTART, move |request, state| {
        reboot_response(request, &state.restart)
    })?;

    // Factory reset erases the configuration but keeps the setup password:
    // it is device identity, and a pre-flashed unit's label must stay true.
    // The response shows the credentials before the device leaves the
    // network — their only appearance in the API.
    server.handler(
        api::FACTORY_RESET,
        move |request, state| match factory_reset(state) {
            Ok(()) => reboot_response_with(
                request,
                &state.restart,
                &api::FactoryResetResponse {
                    rebooting: true,
                    setup_network: api::SetupNetworkResponse {
                        ssid: &state.setup_network.ssid,
                        password: &state.setup_network.password,
                    },
                },
            ),
            Err(error) => mutation_error(request, error),
        },
    )
}

/// Erase the stored crash dump, then the configuration and diagnostics. A dump
/// copies task memory, which can hold the credentials reset erases, and setup
/// mode serves it without a key.
pub(in crate::adapters) fn factory_reset(state: &ApiState) -> Result<(), MutationError> {
    if coredump::state() != CoredumpState::Unavailable {
        coredump::erase().map_err(|error| MutationError::Persistence(format!("{error:#}")))?;
    }
    state
        .lock_store()
        .clear()
        .map_err(|error| MutationError::Persistence(format!("{error:#}")))
}
