//! PCM transport policy, key rotation, and recovery handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    adapters::random::EspRandom,
    api,
    config::RuntimeConfig,
    mutation::MutationError,
    transport::{self, TransportMode},
};

use super::super::{
    persistence::{lock_config, save_configuration},
    requests::form,
    responses::{json_response, mutation_error, reboot_response, unavailable},
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    register_settings(server, state)?;
    register_stage(server, state)?;
    register_verify(server, state)?;
    register_activate(server, state)?;
    register_discard(server, state)?;
    register_rollback(server, state)?;
    register_retire(server, state)?;
    register_recovery(server, state)
}

fn register_settings(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::SET_TRANSPORT, move |mut request| {
        let result = form(&mut request).and_then(|form: api::TransportSettingsRequest| {
            mutate(&state, |next| {
                let previous = next.transport.clone();
                next.transport.contract_version = form.contract_version;
                next.transport.mode = form.mode;
                next.transport.validate()?;
                Ok(previous.requires_restart_to(&next.transport))
            })
        });
        match result {
            Ok(true) => reboot_response(request),
            Ok(false) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_stage(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_KEY_STAGE, move |request| {
        match mutate(&state, |next| {
            Ok(key_response(&next.transport.keys.stage(&mut EspRandom)?))
        }) {
            Ok(response) => json_response(request, 200, &response),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_verify(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_KEY_VERIFY, move |request| {
        let Some(verifier) = state.key_verifier.as_deref() else {
            return unavailable(
                request,
                "secure PCM verification is unavailable in this mode",
            );
        };
        match mutate(&state, |next| {
            let target_host = next.target_host.clone();
            let target_port = next.target_port;
            transport::verify_pending(&mut next.transport, &target_host, target_port, verifier)?;
            Ok(())
        }) {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_activate(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_KEY_ACTIVATE, move |request| {
        match mutate(&state, |next| {
            next.transport.keys.activate()?;
            next.transport.mode = TransportMode::TlsPsk;
            Ok(())
        }) {
            Ok(()) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_discard(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_KEY_DISCARD, move |request| {
        match mutate(&state, |next| Ok(next.transport.keys.discard_pending()?)) {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_rollback(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_KEY_ROLLBACK, move |request| {
        match mutate(&state, |next| Ok(next.transport.keys.rollback_key()?)) {
            Ok(()) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_retire(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_KEY_RETIRE, move |request| {
        match mutate(&state, |next| Ok(next.transport.keys.retire_rollback()?)) {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn register_recovery(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::TRANSPORT_RECOVER, move |request| {
        match mutate(&state, |next| {
            next.transport.mode = TransportMode::Cleartext;
            Ok(key_response(&next.transport.keys.recover(&mut EspRandom)?))
        }) {
            Ok(response) => json_response(request, 200, &response),
            Err(error) => mutation_error(request, error),
        }
    })
}

/// Apply one lifecycle change to a copy of the configuration and expose its
/// result only after the change persisted as a complete state generation.
fn mutate<T>(
    state: &ApiState,
    change: impl FnOnce(&mut RuntimeConfig) -> Result<T, MutationError>,
) -> Result<T, MutationError> {
    let mut next = lock_config(state)?.clone();
    let value = change(&mut next)?;
    save_configuration(state, next)?;
    Ok(value)
}

fn key_response(key: &transport::TransportKey) -> api::TransportKeyResponse {
    api::TransportKeyResponse {
        contract_version: transport::CONTRACT_VERSION,
        key_id: key.id().to_owned(),
        psk: key.psk().hex(),
    }
}
