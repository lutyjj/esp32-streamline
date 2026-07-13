//! API contract, authentication check, restart, and factory-reset handlers.

use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::api;

use super::super::{
    auth::authorized_for,
    responses::{json_response, reboot_response, respond, unauthorized},
    ApiState, ContractServer, OPENAPI,
};

pub(super) fn register_contract(server: &mut ContractServer<'_>) -> Result<()> {
    server.handler(api::OPENAPI, move |request| {
        respond(request, 200, "application/json", OPENAPI)
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

    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::FACTORY_RESET, move |request| {
        if !authorized_for(&request, &state, api::FACTORY_RESET) {
            return unauthorized(request);
        }
        state
            .store
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .clear()?;
        reboot_response(request)
    })
}
