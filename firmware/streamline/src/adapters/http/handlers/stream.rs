//! Runtime streaming pause/resume handler.

use std::sync::Arc;

use anyhow::Result;

use crate::{api, mutation::MutationError};

use super::super::{
    auth::authorized_for,
    requests::form,
    responses::{json_response, mutation_error, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_STREAM, move |mut request| {
        if !authorized_for(&request, &state, api::SET_STREAM) {
            return unauthorized(request);
        }
        let result = (|| -> Result<(), MutationError> {
            let form: api::StreamRequest = form(&mut request)?;
            let Some(stream) = &state.stream else {
                return Err(MutationError::Unavailable(
                    "audio capture is not running".to_owned(),
                ));
            };
            stream.set_streaming_enabled(form.enabled);
            Ok(())
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })
}
