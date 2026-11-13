//! Local provisioning and runtime HTTP adapter.

mod auth;
mod handlers;
mod requests;
mod responses;
mod writes;

/// The audio mutation flow, shared with the button adapter's `cycle_input`.
pub(in crate::adapters) use handlers::audio::set_audio;

use std::{
    ffi::{CStr, CString},
    net::Ipv4Addr,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};

use anyhow::{bail, Result};
use embedded_svc::http::Method;
use esp_idf_svc::{
    handle::RawHandle,
    http::server::{Configuration, EspHttpConnection, EspHttpServer},
    sys::{self, esp, httpd_err_code_t, httpd_req_t},
};

use crate::{
    adapters::{codec::DeviceCodec, mdns::MdnsAdvertisement, nvs::ConfigStore},
    analog_passthrough::AnalogPassthroughState,
    api::{self, Endpoint, HttpMethod},
    board,
    config::RuntimeConfig,
    health::HealthReport,
    mode::Mode,
    profiles::AudioProfileCatalog,
    setup_network::SetupNetwork,
    stream::StreamStatus,
    transport::KeyVerifier,
    update::progress::OtaProgress,
};

// Stored gzipped (build.rs compresses them into OUT_DIR) and served with
// `Content-Encoding: gzip`: raw, these two assets cost 194 KB of the OTA slot.
const INDEX_GZ: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/index.html.gz"));
const OPENAPI_GZ: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/openapi.json.gz"));

pub struct ApiState {
    /// Serializes complete control operations across HTTP and physical buttons.
    pub control: Mutex<()>,
    pub restart: Arc<crate::restart::Restart>,
    pub button_action: crate::task_start::TaskSlot,
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
    pub codec: Option<Arc<Mutex<DeviceCodec<'static>>>>,
    pub analog_passthrough: Arc<Mutex<AnalogPassthroughState>>,
    pub mdns: Option<Arc<Mutex<MdnsAdvertisement>>>,
    pub ota: Arc<OtaProgress>,
    /// The startup health verdict, assembled once at boot (see [`crate::health`]).
    pub health: Arc<HealthReport>,
    /// The setup network's credentials, loaded at boot (see
    /// [`crate::setup_network`]). Stable for the device's life; the API shows
    /// them only in the factory-reset response.
    pub setup_network: SetupNetwork,
    /// Digest-authentication nonce state (see [`crate::auth`]).
    pub auth: Mutex<crate::auth::DigestAuthenticator>,
}

pub fn probe(endpoint: Endpoint) -> Result<()> {
    use crate::adapters::download::{HttpGet, TlsRxBuffer};

    let path = if cfg!(feature = "qemu-fail-management") {
        "/api/missing-management-probe"
    } else {
        endpoint.path
    };
    let mut response = HttpGet::get(&format!("http://127.0.0.1{path}"), TlsRxBuffer::PerRecord)?;
    if response.status() != 200 {
        bail!(
            "management probe {} returned HTTP {}",
            endpoint.path,
            response.status()
        );
    }
    let mut buffer = [0_u8; 512];
    let mut received = 0;
    let started = std::time::Instant::now();
    loop {
        let read = response.read(&mut buffer)?;
        received += read;
        if received > 65_536 || started.elapsed() > std::time::Duration::from_secs(10) {
            bail!(
                "management probe {} exceeded its response budget",
                endpoint.path
            );
        }
        if read == 0 {
            break;
        }
    }
    Ok(())
}

/// Shared-state access for every handler, read and write alike.
///
/// The espidf target's panic strategy is `abort`, so a panic resets the device
/// instead of unwinding and no lock is ever observed poisoned. These accessors
/// therefore unwrap, and no path answers a 500 that only unwinding could
/// produce.
impl ApiState {
    fn lock_config(&self) -> MutexGuard<'_, RuntimeConfig> {
        self.config.lock().expect("configuration lock poisoned")
    }

    fn lock_store(&self) -> MutexGuard<'_, ConfigStore> {
        self.store
            .lock()
            .expect("configuration store lock poisoned")
    }

    fn lock_audio_profiles(&self) -> MutexGuard<'_, AudioProfileCatalog> {
        self.audio_profiles
            .lock()
            .expect("audio profile lock poisoned")
    }
}

fn method(endpoint: Endpoint) -> Method {
    match endpoint.method {
        HttpMethod::Get => Method::Get,
        HttpMethod::Post => Method::Post,
    }
}

/// Thin ESP-IDF binding that refuses to finish unless every declared API
/// operation has exactly one registered handler, and enforces each
/// declaration's authentication and restart policy before the handler runs —
/// a handler cannot forget either check, because the route table owns them.
struct ContractServer<'a> {
    inner: EspHttpServer<'a>,
    state: Arc<OnceLock<Arc<ApiState>>>,
    registered: u64,
}

impl<'a> ContractServer<'a> {
    fn new(inner: EspHttpServer<'a>, state: Arc<OnceLock<Arc<ApiState>>>) -> Self {
        assert!(
            api::ENDPOINTS.len() <= u64::BITS as usize,
            "API endpoint tracker capacity exceeded"
        );
        Self {
            inner,
            state,
            registered: 0,
        }
    }

    fn handler<F>(&mut self, endpoint: Endpoint, handler: F) -> Result<()>
    where
        F: for<'request> Fn(
                embedded_svc::http::server::Request<&mut EspHttpConnection<'request>>,
                &Arc<ApiState>,
            ) -> Result<()>
            + Send
            + 'static,
    {
        let index = api::ENDPOINTS
            .iter()
            .position(|declared| *declared == endpoint)
            .expect("registered endpoint is declared");
        let bit = 1_u64 << index;
        if self.registered & bit != 0 {
            bail!("duplicate API handler for {}", endpoint.path);
        }
        let gate = Arc::clone(&self.state);
        self.inner
            .fn_handler(endpoint.path, method(endpoint), move |request| {
                let state = gate.wait();
                let _control = state.control.lock().expect("control lock poisoned");
                if let Err(challenge) = auth::authorized_for(&request, state, endpoint) {
                    return responses::unauthorized(request, &challenge);
                }
                if endpoint.method == HttpMethod::Post && state.restart.is_pending() {
                    return responses::unavailable(request, "device is restarting");
                }
                if api::RESTARTING.contains(&endpoint) {
                    if let Err(error) = state.ota.require_idle() {
                        return responses::mutation_error(request, error);
                    }
                }
                handler(request, state)
            })?;
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

/// A listener with its complete route table. Requests that reach it before
/// [`start`] publishes the API state wait for that state. The listener lives
/// until the device restarts: dropping it would unregister routes while the
/// server task may still be matching requests.
pub struct Listener {
    _server: EspHttpServer<'static>,
    state: Arc<OnceLock<Arc<ApiState>>>,
}

/// Initialize the listener and register every route before any network
/// interface can accept traffic. ESP-IDF publishes a handler-table slot before
/// it fills that slot in, so a route registered while requests arrive can be
/// matched half-built.
pub fn bind() -> Result<Listener> {
    esp_idf_svc::netif::NetifStack::initialize()?;
    let mut server = EspHttpServer::new(&Configuration {
        // Authenticated transport-key writes serialize a complete atomic state
        // generation before returning the one-time credential. Keep that work
        // on the HTTP task without approaching FreeRTOS's stack guard.
        stack_size: 14_336,
        // One slot per API endpoint and the `/` console handler, so a new route
        // never silently overflows the table.
        max_uri_handlers: api::ENDPOINTS.len() + 1,
        uri_match_wildcard: true,
        ..Default::default()
    })?;
    let state = Arc::new(OnceLock::new());
    server.fn_handler("/", Method::Get, move |request| {
        responses::respond_gzip(request, 200, "text/html; charset=utf-8", INDEX_GZ)
    })?;

    let mut routes = ContractServer::new(server, Arc::clone(&state));
    handlers::register(&mut routes)?;
    let server = routes.finish()?;
    esp!(unsafe {
        sys::httpd_register_err_handler(
            server.handle(),
            sys::httpd_err_code_t_HTTPD_404_NOT_FOUND,
            Some(not_found),
        )
    })?;
    Ok(Listener {
        _server: server,
        state,
    })
}

/// Serve `state` from the listener's routes, and restart the device once an
/// endpoint schedules a restart.
pub fn start(
    listener: &Listener,
    state: Arc<ApiState>,
    captive_portal_address: Option<Ipv4Addr>,
) -> Result<()> {
    let restart = Arc::clone(&state.restart);
    crate::adapters::task::prepare(
        esp_idf_svc::hal::task::thread::ThreadSpawnConfiguration {
            stack_size: 3072,
            ..Default::default()
        },
        move || {
            restart.wait();
            esp_idf_svc::hal::delay::FreeRtos::delay_ms(500);
            unsafe { esp_idf_svc::sys::esp_restart() };
        },
    )?
    .commit();
    let console_url = captive_portal_address.map(|address| {
        CString::new(crate::captive_portal::console_url(address)).expect("a URL has no NUL byte")
    });
    if CAPTIVE_PORTAL.set(console_url).is_err() || listener.state.set(state).is_err() {
        bail!("API state is already published");
    }
    Ok(())
}

/// The setup console URL while the setup network serves clients. ESP-IDF error
/// handlers receive no context, and the firmware runs one listener.
static CAPTIVE_PORTAL: OnceLock<Option<CString>> = OnceLock::new();
const REDIRECT_BODY: &CStr = c"Open the StreamLine setup console.";

/// Answer a request no route matched. While the setup network serves clients,
/// a GET redirects to the setup console, as captive-portal probes expect;
/// anything else gets ESP-IDF's own 404.
unsafe extern "C" fn not_found(
    request: *mut httpd_req_t,
    error: httpd_err_code_t,
) -> sys::esp_err_t {
    let is_get = unsafe { (*request).method } == sys::http_method_HTTP_GET as i32;
    match CAPTIVE_PORTAL.wait() {
        Some(console_url) if is_get => {
            log::info!(
                "redirecting setup HTTP probe to {}",
                console_url.to_string_lossy()
            );
            unsafe {
                sys::httpd_resp_set_status(request, c"303 See Other".as_ptr());
                sys::httpd_resp_set_type(request, c"text/plain; charset=utf-8".as_ptr());
                sys::httpd_resp_set_hdr(request, c"Cache-Control".as_ptr(), c"no-store".as_ptr());
                sys::httpd_resp_set_hdr(request, c"Location".as_ptr(), console_url.as_ptr());
                sys::httpd_resp_send(
                    request,
                    REDIRECT_BODY.as_ptr(),
                    REDIRECT_BODY.to_bytes().len() as isize,
                )
            }
        }
        _ => {
            unsafe { sys::httpd_resp_send_err(request, error, core::ptr::null()) };
            sys::ESP_FAIL
        }
    }
}
