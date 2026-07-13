//! PCM transport policy, key rotation, and recovery handlers.

use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::{
    api,
    transport::{self, RandomBytes, TransportMode},
};

use super::super::{
    auth::authorized_for,
    persistence::save_configuration,
    requests::form,
    responses::{bad_request, json_response, reboot_response, unauthorized, unavailable},
    ApiState, ContractServer,
};

struct EspRandom;

impl RandomBytes for EspRandom {
    fn fill(&mut self, output: &mut [u8]) {
        unsafe { esp_idf_svc::sys::esp_fill_random(output.as_mut_ptr().cast(), output.len()) };
    }
}

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    register_settings(server, state)?;
    register_stage(server, state)?;
    register_verify(server, state)?;
    register_activate(server, state)?;
    register_rollback(server, state)?;
    register_retire(server, state)?;
    register_recovery(server, state)
}

fn register_settings(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_TRANSPORT, move |mut request| {
        if !authorized_for(&request, &state, api::SET_TRANSPORT) {
            return unauthorized(request);
        }
        let result = (|| -> Result<bool> {
            let form: api::TransportSettingsRequest = form(&mut request)?;
            let current = state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let mut next = current.clone();
            next.transport.contract_version = form.contract_version;
            next.transport.mode = form.mode;
            next.transport.validate()?;
            let restart = current.transport.requires_restart_to(&next.transport);
            save_configuration(&state, next)?;
            Ok(restart)
        })();
        match result {
            Ok(true) => reboot_response(request),
            Ok(false) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })
}

fn register_stage(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::TRANSPORT_KEY_STAGE, move |request| {
        if !authorized_for(&request, &state, api::TRANSPORT_KEY_STAGE) {
            return unauthorized(request);
        }
        let result = (|| -> Result<api::TransportKeyResponse> {
            let mut next = state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let key = next.transport.keys.stage(&mut EspRandom)?;
            let response = key_response(&key);
            save_configuration(&state, next)?;
            Ok(response)
        })();
        match result {
            Ok(response) => json_response(request, 200, &response),
            Err(error) => bad_request(request, error),
        }
    })
}

fn register_verify(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::TRANSPORT_KEY_VERIFY, move |request| {
        if !authorized_for(&request, &state, api::TRANSPORT_KEY_VERIFY) {
            return unauthorized(request);
        }
        let Some(verifier) = state.key_verifier.as_deref() else {
            return unavailable(
                request,
                "secure PCM verification is unavailable in this mode",
            );
        };
        let result = (|| -> Result<()> {
            let mut next = state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let target_host = next.target_host.clone();
            let target_port = next.target_port;
            transport::verify_pending(&mut next.transport, &target_host, target_port, verifier)?;
            save_configuration(&state, next)
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })
}

fn register_activate(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::TRANSPORT_KEY_ACTIVATE, move |request| {
        if !authorized_for(&request, &state, api::TRANSPORT_KEY_ACTIVATE) {
            return unauthorized(request);
        }
        match mutate(&state, |next| {
            next.transport.keys.activate()?;
            next.transport.mode = TransportMode::TlsPsk;
            Ok(())
        }) {
            Ok(()) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })
}

fn register_rollback(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::TRANSPORT_KEY_ROLLBACK, move |request| {
        if !authorized_for(&request, &state, api::TRANSPORT_KEY_ROLLBACK) {
            return unauthorized(request);
        }
        match mutate(&state, |next| {
            next.transport
                .keys
                .rollback_key()
                .map_err(anyhow::Error::from)
        }) {
            Ok(()) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })
}

fn register_retire(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::TRANSPORT_KEY_RETIRE, move |request| {
        if !authorized_for(&request, &state, api::TRANSPORT_KEY_RETIRE) {
            return unauthorized(request);
        }
        match mutate(&state, |next| {
            next.transport
                .keys
                .retire_rollback()
                .map_err(anyhow::Error::from)
        }) {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })
}

fn register_recovery(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::TRANSPORT_RECOVER, move |request| {
        if !authorized_for(&request, &state, api::TRANSPORT_RECOVER) {
            return unauthorized(request);
        }
        let result = (|| -> Result<api::TransportKeyResponse> {
            let mut next = state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            next.transport.mode = TransportMode::Cleartext;
            let key = next.transport.keys.recover(&mut EspRandom)?;
            let response = key_response(&key);
            save_configuration(&state, next)?;
            Ok(response)
        })();
        match result {
            Ok(response) => json_response(request, 200, &response),
            Err(error) => bad_request(request, error),
        }
    })
}

fn mutate(
    state: &ApiState,
    change: impl FnOnce(&mut crate::config::RuntimeConfig) -> Result<()>,
) -> Result<()> {
    let mut next = state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .clone();
    change(&mut next)?;
    save_configuration(state, next)
}

fn key_response(key: &transport::TransportKey) -> api::TransportKeyResponse {
    api::TransportKeyResponse {
        contract_version: transport::CONTRACT_VERSION,
        key_id: key.id().to_owned(),
        psk: key.psk().hex(),
    }
}
