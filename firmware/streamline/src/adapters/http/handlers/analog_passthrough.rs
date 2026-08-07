//! Local analog output setting and live codec reconciliation.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    analog_passthrough::AnalogPassthroughRoute, api, config::RuntimeConfig, mutation::MutationError,
};

use super::super::{
    persistence::save_configuration,
    requests::form,
    responses::{json_response, mutation_error},
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::SET_ANALOG_PASSTHROUGH, move |mut request| {
        let result = (|| -> Result<(), MutationError> {
            let form: api::AnalogPassthroughSettingsRequest = form(&mut request)?;
            let capability = state.board.analog_passthrough.as_ref();
            if form.enabled && capability.is_none() {
                return Err(MutationError::Unavailable(
                    "local analog output is not supported by this board".to_owned(),
                ));
            }
            let current = state.lock_config().clone();
            let next = RuntimeConfig {
                analog_passthrough_enabled: form.enabled,
                ..current
            };
            save_configuration(&state, next.clone())?;

            let Some(codec) = &state.codec else {
                let mut passthrough = state
                    .analog_passthrough
                    .lock()
                    .expect("analog passthrough lock poisoned");
                if form.enabled {
                    passthrough.record_fault("audio codec is unavailable");
                    return Err(MutationError::Unavailable(
                        "audio codec is unavailable".to_owned(),
                    ));
                }
                *passthrough = Default::default();
                return Ok(());
            };
            let route = capability.map(|capability| AnalogPassthroughRoute {
                input_line: next.audio.input_line,
                output_line: capability.output_line,
            });
            let mut codec = codec.lock().expect("codec lock poisoned");
            state
                .analog_passthrough
                .lock()
                .expect("analog passthrough lock poisoned")
                .reconcile(form.enabled, route, &mut *codec)
                .map_err(|error| MutationError::Internal(error.to_string()))
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}
