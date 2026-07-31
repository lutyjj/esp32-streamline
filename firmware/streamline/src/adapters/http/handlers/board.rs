//! Board catalog and descriptor-selection handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{api, board, mutation::MutationError, profiles::AudioProfileCatalog};

use super::super::{
    persistence::{lock_audio_profiles, lock_config, lock_store},
    requests::form,
    responses::{json_response, mutation_error, reboot_response},
    ApiState, ContractServer,
};

pub(super) fn register_read(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::BOARDS, move |request| {
        let boards = state
            .board_catalog
            .iter()
            .map(api::CapabilitiesStatus::from_board)
            .collect();
        json_response(
            request,
            200,
            &api::BoardCatalogResponse {
                selected_board_id: state.board.id.as_str(),
                selected_board: api::CapabilitiesStatus::from_board(state.board.as_ref()),
                boards,
            },
        )
    })
}

pub(super) fn register_write(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::SET_BOARD, move |mut request| {
        let result = (|| -> Result<(), MutationError> {
            let form: api::BoardSettingsRequest = form(&mut request)?;
            let update = board::resolve_update(
                &state.board_catalog,
                form.board_id.as_deref(),
                form.descriptor.as_deref(),
            )
            .map_err(|error| MutationError::InvalidInput(error.to_string()))?;
            let selected = update.board();
            let next = lock_config(&state)?
                .clone()
                .with_board_compatible_with(selected);

            let store = lock_store(&state)?;
            if state.mode.has_persisted_configuration() {
                next.validate(selected).map_err(|error| {
                    MutationError::InvalidInput(format!("invalid configuration: {error:?}"))
                })?;
            }
            store
                .save_board_state(
                    selected,
                    update.is_custom(),
                    state.mode.has_persisted_configuration().then_some(&next),
                )
                .map_err(|error| MutationError::Persistence(format!("{error:#}")))?;
            *lock_config(&state)? = next;
            *lock_audio_profiles(&state)? = AudioProfileCatalog::empty(selected);
            Ok(())
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })
}
