//! Firmware update, installation, and rollback handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{adapters::ota as ota_adapter, api, mutation::MutationError, update};

use super::super::{
    auth::authorized_for,
    requests::form,
    responses::{mutation_error, ota_accepted, reboot_response, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    // Check GitHub for a newer release without installing it. The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for the
    // outcome (`up-to-date` or `update-available`).
    let state_for_check = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::OTA_CHECK, move |request| {
        if let Err(challenge) = authorized_for(&request, &state_for_check, api::OTA_CHECK) {
            return unauthorized(request, &challenge);
        }
        ota_accepted(
            request,
            ota_adapter::spawn_check(Arc::clone(&state_for_check.ota)),
        )
    })?;

    // Flash an image to the inactive OTA slot. An empty body pulls the latest
    // GitHub release; `url` + `sha256` form fields install that exact pinned
    // image instead (development installs, see docs/ota.md). The work runs on a
    // background task; clients poll `/api/status` (the `ota` field) for
    // progress, and the device reboots into the new image on success.
    let state_for_ota = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::OTA_UPDATE, move |mut request| {
        if let Err(challenge) = authorized_for(&request, &state_for_ota, api::OTA_UPDATE) {
            return unauthorized(request, &challenge);
        }
        let form: api::OtaUpdateRequest = match form(&mut request) {
            Ok(form) => form,
            Err(error) => return mutation_error(request, error),
        };
        let source =
            match update::custom_image_from_form(form.url.as_deref(), form.sha256.as_deref()) {
                Ok(None) => ota_adapter::Source::LatestRelease,
                Ok(Some(image)) => ota_adapter::Source::Custom(image),
                Err(error) => return mutation_error(request, MutationError::InvalidInput(error)),
            };
        ota_accepted(
            request,
            ota_adapter::spawn_update(
                Arc::clone(&state_for_ota.ota),
                Arc::clone(&state_for_ota.store),
                source,
                state_for_ota.stream.clone(),
            ),
        )
    })?;

    // Roll back to the previous firmware by booting the other slot. Flip the
    // boot selection first so an unavailable rollback returns an error instead
    // of a false "rebooting"; the device then reboots into the previous image,
    // which its boot path re-confirms.
    let state_for_rollback = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::OTA_ROLLBACK, move |request| {
        if let Err(challenge) = authorized_for(&request, &state_for_rollback, api::OTA_ROLLBACK) {
            return unauthorized(request, &challenge);
        }
        match ota_adapter::select_rollback_slot() {
            Ok(()) => reboot_response(request),
            // No stored previous image is a state conflict, not a bad request.
            Err(error) => mutation_error(request, MutationError::Conflict(format!("{error:#}"))),
        }
    })
}
