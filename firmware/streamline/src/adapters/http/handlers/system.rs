//! API contract, authentication check, restart, and factory-reset handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{adapters::random::EspRandom, api, mutation::MutationError};

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
    // The setup network's join credentials, so the console can show the owner
    // the password a recovery fallback will require. Admin-gated: the WPA2
    // password is a secret. On an unprovisioned device the gate is open like
    // every write, and the reader is already on the setup network it names.
    let state_for_setup_network = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SETUP_NETWORK, move |request| {
        if !authorized_for(&request, &state_for_setup_network, api::SETUP_NETWORK) {
            return unauthorized(request);
        }
        let network = &state_for_setup_network.setup_network;
        json_response(
            request,
            200,
            &api::SetupNetworkResponse {
                ssid: &network.ssid,
                password: &network.password,
            },
        )
    })?;

    // Verify an admin key without changing anything, so the console can reject
    // a wrong key at unlock time instead of on the first settings write.
    let state_for_unlock = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::UNLOCK, move |request| {
        if !authorized_for(&request, &state_for_unlock, api::UNLOCK) {
            return unauthorized(request);
        }
        json_response(request, 200, &api::Ack::ok())
    })?;

    // Plain reboot with settings intact; recovers a wedged stream without a
    // trip to the power plug.
    let state_for_restart = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::RESTART, move |request| {
        if !authorized_for(&request, &state_for_restart, api::RESTART) {
            return unauthorized(request);
        }
        reboot_response(request)
    })?;

    // Factory reset regenerates the setup-AP password and answers with the new
    // credentials: this response is the last chance to show them before the
    // device leaves the network and starts the setup AP they open.
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::FACTORY_RESET, move |request| {
        if !authorized_for(&request, &state, api::FACTORY_RESET) {
            return unauthorized(request);
        }
        let result = (|| -> Result<String, MutationError> {
            let store = lock_store(&state)?;
            store
                .clear()
                .map_err(|error| MutationError::Persistence(format!("{error:#}")))?;
            store
                .ensure_setup_network_password(&mut EspRandom)
                .map_err(|error| MutationError::Persistence(format!("{error:#}")))
        })();
        match result {
            Ok(password) => reboot_response_with(
                request,
                &api::FactoryResetResponse {
                    rebooting: true,
                    setup_network: api::SetupNetworkResponse {
                        ssid: &state.setup_network.ssid,
                        password: &password,
                    },
                },
            ),
            Err(error) => mutation_error(request, error),
        }
    })
}
