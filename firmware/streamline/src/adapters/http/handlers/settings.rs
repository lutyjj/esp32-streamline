//! Device, network, identity, and update-policy settings handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    api,
    config::{AutoUpdateSchedule, RuntimeConfig},
    mutation::MutationError,
    recovery,
};

use super::super::{
    auth::authorized_for,
    persistence::{lock_config, save_configuration},
    requests::form,
    responses::{json_response, mutation_error, reboot_response, respond, serialize, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register_read(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::SETTINGS, move |request| {
        respond(request, 200, "application/json", &config_json(&state))
    })
}

pub(super) fn register_network_writes(
    server: &mut ContractServer<'_>,
    state: &Arc<ApiState>,
) -> Result<()> {
    // Mutating endpoints require the admin key once one is provisioned (see
    // `authorized_for`); an unconfigured device accepts setup writes so the first
    // key can be set. Wi-Fi and the stream target are separate nouns: each write
    // validates and persists only its own fields, so a malformed target host
    // cannot fail a Wi-Fi save and a Wi-Fi save cannot smuggle in half-typed
    // target edits.
    let state_for_wifi = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_WIFI, move |mut request| {
        if !authorized_for(&request, &state_for_wifi, api::SET_WIFI) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::WifiSettingsRequest = form(&mut request)?;
            let current = lock_config(&state_for_wifi)?.clone();
            // Commissioning may set the initial stream target in the same
            // write, because the device reboots onto the home network right
            // after and the two cannot be posted separately. Absent target
            // fields are preserved, so a steady-state Wi-Fi change leaves the
            // target alone.
            let next = recovery::replace_wifi(
                current,
                form.ssid,
                form.password,
                form.admin_secret,
                form.target_host.map(|value| value.trim().to_owned()),
                form.target_port,
            );
            save_configuration(&state_for_wifi, next)
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })?;

    // The stream target is a stage-3 change, not commissioning: it sets only
    // host and port and leaves Wi-Fi and the admin key untouched. Blank host
    // clears the target ("no bridge yet"). A target change takes effect on the
    // next boot; applying it to the running stream without a reboot is deferred
    // (the stream target is fixed when the network task spawns).
    let state_for_target = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_TARGET, move |mut request| {
        if !authorized_for(&request, &state_for_target, api::SET_TARGET) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::TargetSettingsRequest = form(&mut request)?;
            let current = lock_config(&state_for_target)?.clone();
            let target_host = form.target_host.trim().to_owned();
            let target_port = form.target_port.unwrap_or(current.target_port);
            let next = RuntimeConfig {
                target_host,
                target_port,
                ..current
            };
            save_configuration(&state_for_target, next)
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })
}

pub(super) fn register_identity_writes(
    server: &mut ContractServer<'_>,
    state: &Arc<ApiState>,
) -> Result<()> {
    // The friendly device name only labels the console and browser tab, so it
    // applies immediately; no reboot is needed. Blank clears the name.
    let state_for_name = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_NAME, move |mut request| {
        if !authorized_for(&request, &state_for_name, api::SET_NAME) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::NameSettingsRequest = form(&mut request)?;
            let mut next = lock_config(&state_for_name)?.clone();
            next.device_name = form.name.trim().to_owned();
            save_configuration(&state_for_name, next.clone())?;
            refresh_mdns_name(&state_for_name, &next);
            Ok(())
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })?;

    let state_for_admin_key = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_ADMIN_KEY, move |mut request| {
        if !authorized_for(&request, &state_for_admin_key, api::SET_ADMIN_KEY) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::AdminKeySettingsRequest = form(&mut request)?;
            let mut next = lock_config(&state_for_admin_key)?.clone();
            next.admin_secret = form.admin_secret;
            save_configuration(&state_for_admin_key, next)
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}

pub(super) fn register_firmware_write(
    server: &mut ContractServer<'_>,
    state: &Arc<ApiState>,
) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_FIRMWARE, move |mut request| {
        if !authorized_for(&request, &state, api::SET_FIRMWARE) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::FirmwareSettingsRequest = form(&mut request)?;
            let auto_update_schedule = match form.auto_update_schedule {
                api::AutoUpdateScheduleRequest::Disabled => AutoUpdateSchedule::Disabled,
                api::AutoUpdateScheduleRequest::Daily => AutoUpdateSchedule::Daily,
                api::AutoUpdateScheduleRequest::Weekly => AutoUpdateSchedule::Weekly,
            };
            let current = lock_config(&state)?.clone();
            let next = RuntimeConfig {
                auto_update_schedule,
                ..current
            };
            if state.mode.has_persisted_configuration() {
                save_configuration(&state, next)
            } else {
                *lock_config(&state)? = next;
                Ok(())
            }
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}

fn config_json(state: &ApiState) -> String {
    let config = state.config.lock().expect("configuration lock poisoned");
    serialize(&api::ConfigResponse {
        device_name: &config.device_name,
        ssid: &config.ssid,
        target_host: &config.target_host,
        target_port: config.target_port,
        transport: api::TransportStatus {
            contract_version: config.transport.contract_version,
            mode: config.transport.mode,
            active_key_id: config.transport.keys.active().map(|key| key.id()),
            pending_key_id: config.transport.keys.pending().map(|key| key.id()),
            pending_verified: config.transport.keys.pending_verified(),
            rollback_key_id: config.transport.keys.rollback().map(|key| key.id()),
        },
        input_line: config.audio.input_line,
        input_gain: config.audio.input_gain,
        adc_attenuation_db: config.audio.adc_attenuation_db,
        auto_update_schedule: config.auto_update_schedule.into(),
        config_source: "nvs",
    })
}

fn refresh_mdns_name(state: &ApiState, config: &RuntimeConfig) {
    let Some(mdns) = &state.mdns else {
        return;
    };
    match mdns.lock() {
        Ok(mut advertisement) => {
            if let Err(error) = advertisement.set_instance_name(config) {
                log::warn!("could not refresh mDNS instance name: {error:#}");
            }
        }
        Err(_) => log::warn!("could not refresh mDNS instance name: lock poisoned"),
    }
}
