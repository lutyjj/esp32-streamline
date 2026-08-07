//! Board button action assignment handler.

use std::sync::Arc;

use anyhow::Result;

use crate::{api, mutation::MutationError};

use super::super::{
    requests::form,
    responses::{json_response, mutation_error},
    writes::update_configuration,
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::SET_BUTTON, move |mut request| {
        // The poll task reads the live configuration, so a new assignment fires
        // without a reboot whether it persisted or was staged.
        let result = (|| -> Result<(), MutationError> {
            let form: api::ButtonSettingsRequest = form(&mut request)?;
            if !state.board.has_button(&form.id) {
                return Err(MutationError::InvalidInput(format!(
                    "unknown button id '{}'",
                    form.id
                )));
            }
            update_configuration(&state, |next| {
                next.button_actions.insert(form.id, form.action);
                Ok(())
            })
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}
