//! Board catalog and descriptor-selection handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    api, board, mode::ConfigWrite, mutation::MutationError, profiles::AudioProfileCatalog,
};

use super::super::{
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
            let next = state
                .lock_config()
                .clone()
                .with_board_compatible_with(selected);

            // The board record commits in every mode, because the selection is
            // what the next boot resolves its descriptor from. The
            // configuration rides along only where one is already durable.
            let persisted = match state.mode.config_write() {
                ConfigWrite::Persist => {
                    next.validate(selected).map_err(|error| {
                        MutationError::InvalidInput(format!("invalid configuration: {error:?}"))
                    })?;
                    Some(&next)
                }
                ConfigWrite::Stage => None,
            };
            state
                .lock_store()
                .save_board_state(selected, update.is_custom(), persisted)
                .map_err(|error| MutationError::Persistence(format!("{error:#}")))?;
            *state.lock_config() = next;
            *state.lock_audio_profiles() = AudioProfileCatalog::empty(selected);
            Ok(())
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })
}
