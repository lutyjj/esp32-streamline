//! Board button action assignment handler.

use std::sync::Arc;

use anyhow::Result;

use crate::{api, mutation::MutationError};

use super::super::{
    auth::authorized_for,
    persistence::{lock_config, save_configuration},
    requests::form,
    responses::{json_response, mutation_error, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_BUTTON, move |mut request| {
        if let Err(challenge) = authorized_for(&request, &state, api::SET_BUTTON) {
            return unauthorized(request, &challenge);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::ButtonSettingsRequest = form(&mut request)?;
            if !state.board.has_button(&form.id) {
                return Err(MutationError::InvalidInput(format!(
                    "unknown button id '{}'",
                    form.id
                )));
            }
            let mut next = lock_config(&state)?.clone();
            next.button_actions.insert(form.id, form.action);
            // The poll task reads the live configuration, so a persisted
            // assignment applies without a reboot. In setup mode nothing is
            // persisted yet; update memory so the button still fires the choice.
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
