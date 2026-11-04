//! Runtime streaming pause/resume handler.

use anyhow::Result;

use crate::{api, mutation::MutationError};

use super::super::{
    requests::form,
    responses::{json_response, mutation_error},
    ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>) -> Result<()> {
    server.handler(api::SET_STREAM, move |mut request, state| {
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
