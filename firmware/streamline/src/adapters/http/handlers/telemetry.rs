//! Authenticated lifecycle controls for volatile diagnostic sessions.

use super::super::{
    requests::form,
    responses::{json_response, mutation_error},
    ApiState, ContractServer,
};
use crate::{api, mutation::MutationError};
use anyhow::Result;
use std::sync::Arc;

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let read = Arc::clone(state);
    server.handler(api::TELEMETRY_STATUS, move |request| {
        json_response(request, 200, &read.telemetry.snapshot())
    })?;
    let start = Arc::clone(state);
    server.handler(api::TELEMETRY_START, move |mut request| {
        let result = (|| -> Result<(), MutationError> {
            let config: api::SessionRequest = form(&mut request)?;
            config.validate()?;
            start.mode.require_commissioned("starting telemetry")?;
            start.ota.while_idle(|| {
                start.telemetry.can_start()?;
                crate::adapters::telemetry::start(&start.telemetry, config)
            })
        })();
        match result {
            Ok(()) => json_response(request, 202, &start.telemetry.snapshot()),
            Err(error) => mutation_error(request, error),
        }
    })?;
    let stop = Arc::clone(state);
    server.handler(api::TELEMETRY_STOP, move |request| {
        stop.telemetry.stop();
        json_response(request, 202, &stop.telemetry.snapshot())
    })
}
