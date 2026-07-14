//! Board LED role assignment handler.

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
    server.handler::<anyhow::Error, _>(api::SET_LED, move |mut request| {
        if !authorized_for(&request, &state, api::SET_LED) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::LedSettingsRequest = form(&mut request)?;
            if !state.board.has_led(&form.id) {
                return Err(MutationError::InvalidInput(format!(
                    "unknown LED id '{}'",
                    form.id
                )));
            }
            let mut next = lock_config(&state)?.clone();
            next.led_roles.insert(form.id, form.role);
            // The render task reads the live configuration, so a persisted role
            // applies without a reboot. In setup mode nothing is persisted yet;
            // update memory so the LED still reflects the choice.
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
