//! Bridge discovery handler.

use anyhow::Result;

use crate::{api, mode::Mode};

use super::super::{
    responses::{json_response, unavailable},
    ContractServer,
};

pub(super) fn register(server: &mut ContractServer<'_>) -> Result<()> {
    server.handler(api::BRIDGES, move |request, state| {
        let Some(mdns) = &state.mdns else {
            // mDNS runs only on the home network, where it can also fail to start.
            let reason = if state.mode == Mode::Provisioned {
                "mDNS did not start; see the device log"
            } else {
                "bridge discovery needs the home network"
            };
            return unavailable(request, reason);
        };
        let found = mdns.lock().expect("mDNS lock poisoned").bridges();
        match found {
            Ok(bridges) => json_response(request, 200, &api::BridgesResponse { bridges }),
            Err(error) => {
                log::warn!("bridge discovery failed: {error:#}");
                unavailable(request, "bridge discovery failed")
            }
        }
    })
}
