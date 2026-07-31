//! Device log handler.

use anyhow::Result;

use crate::{adapters::logs, api};

use super::super::{
    responses::{json_response, unavailable},
    ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>) -> Result<()> {
    // Behind the admin key: log lines name the joined network, the bridge, and
    // the addresses the device talks to. Reads that stay open elsewhere in this
    // API return facts chosen for publication; this one returns whatever the
    // firmware said.
    server.handler(api::LOGS, move |request| {
        // Copy under the capture lock, serialize after it: the response goes
        // out over a socket, and holding the lock for that would block every
        // task that logs.
        match logs::with_buffers(api::LogsResponse::from_buffers) {
            Some(captured) => json_response(request, 200, &captured),
            None => unavailable(request, "log capture is not running"),
        }
    })
}
