//! API contract, authentication check, restart, and factory-reset handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{api, mutation::MutationError};

use super::super::{
    auth::authorized_for,
    persistence::lock_store,
    responses::{
        json_response, mutation_error, reboot_response, reboot_response_with, respond_gzip,
        unauthorized,
    },
    ApiState, ContractServer, OPENAPI_GZ,
};

pub(super) fn register_contract(server: &mut ContractServer<'_>) -> Result<()> {
    server.handler(api::OPENAPI, move |request| {
        respond_gzip(request, 200, "application/json", OPENAPI_GZ)
    })
}

pub(super) fn register_actions(
    server: &mut ContractServer<'_>,
    state: &Arc<ApiState>,
) -> Result<()> {
    // Verify an admin key without changing anything, so the console can reject
    // a wrong key at unlock time instead of on the first settings write.
    let state_for_unlock = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::UNLOCK, move |request| {
        if let Err(challenge) = authorized_for(&request, &state_for_unlock, api::UNLOCK) {
            return unauthorized(request, &challenge);
        }
        json_response(request, 200, &api::Ack::ok())
    })?;

    // Plain reboot with settings intact; recovers a wedged stream without a
    // trip to the power plug.
    let state_for_restart = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::RESTART, move |request| {
        if let Err(challenge) = authorized_for(&request, &state_for_restart, api::RESTART) {
            return unauthorized(request, &challenge);
        }
        reboot_response(request)
    })?;

    // Factory reset erases the configuration but keeps the setup password:
    // it is device identity, and a pre-flashed unit's label must stay true.
    // The response shows the credentials before the device leaves the
    // network — their only appearance in the API.
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::FACTORY_RESET, move |request| {
        if let Err(challenge) = authorized_for(&request, &state, api::FACTORY_RESET) {
            return unauthorized(request, &challenge);
        }
        let result = (|| -> Result<(), MutationError> {
            lock_store(&state)?
                .clear()
                .map_err(|error| MutationError::Persistence(format!("{error:#}")))
        })();
        match result {
            Ok(()) => reboot_response_with(
                request,
                &api::FactoryResetResponse {
                    rebooting: true,
                    setup_network: api::SetupNetworkResponse {
                        ssid: &state.setup_network.ssid,
                        password: &state.setup_network.password,
                    },
                },
            ),
            Err(error) => mutation_error(request, error),
        }
    })
}
