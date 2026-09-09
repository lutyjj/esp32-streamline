//! Board LED role assignment handler.

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
    server.handler(api::SET_LED, move |mut request| {
        // The render task reads the live configuration, so a new role applies
        // without a reboot whether it persisted or was staged.
        let result = (|| -> Result<(), MutationError> {
            let form: api::LedSettingsRequest = form(&mut request)?;
            if !state.board.has_led(&form.id) {
                return Err(MutationError::InvalidInput(format!(
                    "unknown LED id '{}'",
                    form.id
                )));
            }
            update_configuration(&state, |next| {
                next.led_roles.insert(form.id, form.role);
                Ok(())
            })
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}
