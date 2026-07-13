//! Board catalog and descriptor-selection handlers.

use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::{api, board, profiles::AudioProfileCatalog};

use super::super::{
    auth::authorized_for,
    requests::form,
    responses::{bad_request, reboot_response, respond, serialize, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register_read(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::BOARDS, move |request| {
        respond(
            request,
            200,
            "application/json",
            &board_catalog_json(&state),
        )
    })
}

pub(super) fn register_write(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_BOARD, move |mut request| {
        if !authorized_for(&request, &state, api::SET_BOARD) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::BoardSettingsRequest = form(&mut request)?;
            let update = board::resolve_update(
                &state.board_catalog,
                form.board_id.as_deref(),
                form.descriptor.as_deref(),
            )?;
            let selected = update.board();
            let next = state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone()
                .with_audio_compatible_with(selected);

            let store = state
                .store
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?;
            if state.mode.has_persisted_configuration() {
                next.validate(selected)
                    .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
            }
            store.save_board_state(
                selected,
                update.is_custom(),
                state.mode.has_persisted_configuration().then_some(&next),
            )?;
            *state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))? = next;
            *state
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))? =
                AudioProfileCatalog::empty(selected);
            Ok(())
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })
}

fn board_catalog_json(state: &ApiState) -> String {
    let boards = state
        .board_catalog
        .iter()
        .map(api::CapabilitiesStatus::from_board)
        .collect();
    serialize(&api::BoardCatalogResponse {
        selected_board_id: state.board.id.as_str(),
        selected_board: api::CapabilitiesStatus::from_board(state.board.as_ref()),
        boards,
    })
}
