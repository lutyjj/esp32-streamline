//! Device log handler.

use std::sync::Arc;

use anyhow::Result;

use crate::{adapters::logs, api};

use super::super::{
    auth::authorized_for,
    responses::{json_response, unauthorized, unavailable},
    ApiState, ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    // Behind the admin key: log lines name the joined network, the bridge, and
    // the addresses the device talks to. Reads that stay open elsewhere in this
    // API return facts chosen for publication; this one returns whatever the
    // firmware said.
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::LOGS, move |request| {
        if let Err(challenge) = authorized_for(&request, &state, api::LOGS) {
            return unauthorized(request, &challenge);
        }
        // Copy under the capture lock, serialize after it: the response goes
        // out over a socket, and holding the lock for that would block every
        // task that logs.
        match logs::with_buffers(api::LogsResponse::from_buffers) {
            Some(captured) => json_response(request, 200, &captured),
            None => unavailable(request, "log capture is not running"),
        }
    })
}
