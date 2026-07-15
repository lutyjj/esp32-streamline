//! Local provisioning and runtime HTTP adapter.

mod auth;
mod handlers;
mod persistence;
mod requests;
mod responses;

use std::{
    fmt::Debug,
    net::Ipv4Addr,
    sync::{Arc, Mutex},
};

use anyhow::{bail, Result};
use embedded_svc::http::Method;
use esp_idf_svc::http::server::{Configuration, EspHttpConnection, EspHttpServer};

use crate::{
    adapters::{codec::CodecControl, mdns::MdnsAdvertisement, nvs::ConfigStore, ota::OtaProgress},
    analog_passthrough::AnalogPassthroughState,
    api::{self, Endpoint, HttpMethod},
    board,
    config::RuntimeConfig,
    health::HealthReport,
    profiles::AudioProfileCatalog,
    stream::StreamStatus,
    transport::KeyVerifier,
};

const INDEX: &str = include_str!("../../../../../console/dist/index.html");
const OPENAPI: &str = include_str!("../../../../../docs/openapi.json");

/// The boot contract: the one decision made at startup that fixes which
/// services run and who may write until the next reboot.
///
/// A state earns a variant here only if it changes the service set or the
/// trust model, and only at boot. Anything that changes at runtime is status
/// (`metrics.playing`, `ota.phase`); anything that is a configuration
/// difference reads from config (an empty `target_host` is "no bridge yet",
/// not a mode).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    /// Unconfigured: own open AP, writes accepted so a first admin key can be
    /// set. Capture and streaming are down.
    Setup,
    /// A provisioned device that could not join its saved Wi-Fi starts the
    /// setup AP with its validated state, keeps writes behind its key, and
    /// retries the saved network in the background so it rejoins on its own. A
    /// persisted local analog route remains independent of that network fault.
    Recovery,
    /// Station on the home network: console behind the admin key, capture
    /// running; the TCP stream runs only while a bridge target is configured.
    Provisioned,
}

impl Mode {
    const fn has_persisted_configuration(self) -> bool {
        matches!(self, Self::Recovery | Self::Provisioned)
    }
}

pub struct ApiState {
    pub mode: Mode,
    pub hostname: String,
    pub board_catalog: Arc<Vec<board::Board>>,
    pub board: Arc<board::Board>,
    pub config: Arc<Mutex<RuntimeConfig>>,
    pub audio_profiles: Arc<Mutex<AudioProfileCatalog>>,
    pub store: Arc<Mutex<ConfigStore>>,
    pub stream: Option<Arc<StreamStatus>>,
    pub key_verifier: Option<Arc<dyn KeyVerifier>>,
    /// Live codec control for immediate audio and local-output changes. It also
    /// stays available in network recovery when persisted local output is on.
    pub codec: Option<Arc<Mutex<CodecControl<'static>>>>,
    pub analog_passthrough: Arc<Mutex<AnalogPassthroughState>>,
    pub mdns: Option<Arc<Mutex<MdnsAdvertisement>>>,
    pub ota: Arc<OtaProgress>,
    /// The startup health verdict, assembled once at boot (see [`crate::health`]).
    pub health: Arc<HealthReport>,
    /// The version the inactive slot would roll back into, read once at boot;
    /// `None` when no valid previous image is stored. Fixed until the next OTA,
    /// which reboots and re-reads it.
    pub rollback: Option<String>,
}

fn method(endpoint: Endpoint) -> Method {
    match endpoint.method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    }
}

/// Thin ESP-IDF binding that refuses to finish unless every declared API
/// operation has exactly one registered handler.
struct ContractServer<'a> {
    inner: EspHttpServer<'a>,
    registered: u64,
}

impl<'a> ContractServer<'a> {
    fn new(inner: EspHttpServer<'a>) -> Self {
        assert!(
            api::ENDPOINTS.len() <= u64::BITS as usize,
            "API endpoint tracker capacity exceeded"
        );
        Self {
            inner,
            registered: 0,
        }
    }

    fn handler<E, F>(&mut self, endpoint: Endpoint, handler: F) -> Result<()>
    where
        F: for<'request> Fn(
                embedded_svc::http::server::Request<&mut EspHttpConnection<'request>>,
            ) -> std::result::Result<(), E>
            + Send
            + 'static,
        E: Debug,
    {
        let index = api::ENDPOINTS
            .iter()
            .position(|declared| *declared == endpoint)
            .expect("registered endpoint is declared");
        let bit = 1_u64 << index;
        if self.registered & bit != 0 {
            bail!("duplicate API handler for {}", endpoint.path);
        }
        self.inner
            .fn_handler(endpoint.path, method(endpoint), handler)?;
        self.registered |= bit;
        Ok(())
    }

    fn finish(self) -> Result<EspHttpServer<'a>> {
        let expected = (1_u64 << api::ENDPOINTS.len()) - 1;
        if self.registered != expected {
            let missing = api::ENDPOINTS
                .iter()
                .enumerate()
                .filter(|(index, _)| self.registered & (1_u64 << index) == 0)
                .map(|(_, endpoint)| endpoint.path)
                .collect::<Vec<_>>()
                .join(", ");
            bail!("missing API handlers: {missing}");
        }
        Ok(self.inner)
    }
}

pub fn start(
    state: Arc<ApiState>,
    captive_portal_address: Option<Ipv4Addr>,
) -> Result<EspHttpServer<'static>> {
    let captive_portal_enabled = captive_portal_address.is_some();
    let mut server = EspHttpServer::new(&Configuration {
        // Authenticated transport-key writes serialize a complete atomic state
        // generation before returning the one-time credential. Keep that work
        // on the HTTP task without approaching FreeRTOS's stack guard.
        stack_size: 16_384,
        // One slot per API endpoint, the `/` console handler, and the optional
        // setup fallback, so a new route never silently overflows the table.
        max_uri_handlers: api::ENDPOINTS.len() + 1 + usize::from(captive_portal_enabled),
        uri_match_wildcard: captive_portal_enabled,
        ..Default::default()
    })?;
    server.fn_handler("/", Method::Get, move |request| {
        responses::respond(request, 200, "text/html; charset=utf-8", INDEX)
    })?;

    let mut server = ContractServer::new(server);
    handlers::register(&mut server, &state)?;
    let mut server = server.finish()?;
    if let Some(address) = captive_portal_address {
        let console_url = crate::captive_portal::console_url(address);
        server.fn_handler("/*", Method::Get, move |request| {
            log::info!("redirecting setup HTTP probe to {console_url}");
            responses::redirect_to_console(request, &console_url)
        })?;
    }
    Ok(server)
}
