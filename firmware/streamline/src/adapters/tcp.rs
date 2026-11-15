//! Bounded cleartext or TLS 1.3 PSK transport for the streaming task.

use std::{
    ffi::{CStr, CString},
    fmt,
    io::Write,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    os::fd::AsRawFd,
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use esp_idf_svc::sys;

use crate::{
    config::RuntimeConfig,
    stream::{PacketSink, SendFailed},
    transport::{
        write_all_with, KeyVerifier, PcmConnector, PcmStream, ReconnectingSender, TransportKey,
        TransportMode, WriteAllError,
    },
    transport_diagnostics::TlsFailure,
};

const CLEARTEXT_TIMEOUT: Duration = Duration::from_millis(250);
const TLS_TIMEOUT_MS: i32 = 2_000;
const TLS_CIPHERSUITES: [i32; 2] = [sys::MBEDTLS_TLS1_3_AES_128_GCM_SHA256 as i32, 0];
const TLS_VERSION: &[u8] = b"TLSv1.3";
const TLS_CIPHERSUITE: &[u8] = b"TLS1-3-AES-128-GCM-SHA256";

// TLS 1.3 reserves an inner content type and rounds plaintext up for padding.
const _: () = assert!(
    sys::CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN as usize
        >= crate::stream::MAX_BATCH_BYTES
            + sys::MBEDTLS_SSL_CID_TLS1_3_PADDING_GRANULARITY as usize
);

#[derive(Clone)]
enum TransportSecurity {
    Cleartext,
    TlsPsk(TransportKey),
}

/// A configured bridge endpoint, resolved again for each connection attempt.
#[derive(Clone)]
pub struct TargetAddress {
    host: String,
    port: u16,
    security: TransportSecurity,
}

impl TargetAddress {
    pub fn from_config(config: &RuntimeConfig) -> Result<Self> {
        let port = config.target_port;
        let security = match config.transport.mode {
            TransportMode::Cleartext => TransportSecurity::Cleartext,
            TransportMode::TlsPsk => TransportSecurity::TlsPsk(
                config
                    .transport
                    .keys
                    .active()
                    .cloned()
                    .ok_or_else(|| anyhow!("secure PCM transport has no active key"))?,
            ),
        };
        Ok(Self {
            host: config.target_host.clone(),
            port,
            security,
        })
    }
}

/// A lazily connected sender. Any I/O or authentication failure drops the
/// connection; secure mode never retries against the cleartext listener.
pub struct TcpClient {
    sender: ReconnectingSender<AdapterConnector>,
}

enum Connection {
    Cleartext(TcpStream),
    // Fields drop in order, so ESP-TLS stays quiet while the connection closes.
    Tls(TlsConnection, QuietEspTls),
}

impl TcpClient {
    pub fn new(target: TargetAddress) -> Self {
        Self {
            sender: ReconnectingSender::new(AdapterConnector {
                target,
                lowest_stack_free: u32::MAX,
            }),
        }
    }
}

impl PacketSink for TcpClient {
    fn send(
        &mut self,
        bytes: &[u8],
        ready: impl FnOnce() -> bool,
    ) -> std::result::Result<Option<bool>, SendFailed> {
        self.sender
            .send_all(bytes, ready)
            .map_err(|error| SendFailed {
                secure_handshake: error.is_secure_handshake(),
                cause: format!("{error:#}"),
            })
    }

    fn disconnect(&mut self) {
        self.sender.disconnect();
    }
}

#[derive(Debug)]
pub struct TcpSendError {
    secure_handshake: bool,
    source: anyhow::Error,
}

impl TcpSendError {
    pub const fn is_secure_handshake(&self) -> bool {
        self.secure_handshake
    }

    fn handshake(source: anyhow::Error) -> Self {
        Self {
            secure_handshake: true,
            source,
        }
    }

    fn io(source: impl Into<anyhow::Error>) -> Self {
        Self {
            secure_handshake: false,
            source: source.into(),
        }
    }
}

impl fmt::Display for TcpSendError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.source, formatter)
    }
}

impl std::error::Error for TcpSendError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

struct AdapterConnector {
    target: TargetAddress,
    /// The lowest stack high-water mark a handshake has logged.
    lowest_stack_free: u32,
}

impl PcmConnector for AdapterConnector {
    type Error = TcpSendError;
    type Stream = Connection;

    fn connect(&mut self) -> std::result::Result<Self::Stream, Self::Error> {
        let socket =
            resolve_socket(&self.target.host, self.target.port).map_err(TcpSendError::io)?;
        match &self.target.security {
            TransportSecurity::Cleartext => {
                let stream = TcpStream::connect_timeout(&socket, CLEARTEXT_TIMEOUT)
                    .with_context(|| format!("TCP connect to {} failed", socket))
                    .map_err(TcpSendError::io)?;
                stream.set_nodelay(true).map_err(TcpSendError::io)?;
                set_media_priority(stream.as_raw_fd()).map_err(TcpSendError::io)?;
                stream
                    .set_write_timeout(Some(CLEARTEXT_TIMEOUT))
                    .map_err(TcpSendError::io)?;
                Ok(Connection::Cleartext(stream))
            }
            TransportSecurity::TlsPsk(key) => {
                let quiet = QuietEspTls::new();
                let stream =
                    TlsConnection::connect(socket, key.clone()).map_err(TcpSendError::handshake)?;
                // A null handle selects the sender task. The mark only falls, so a
                // reconnect loop stops logging once it settles.
                let free = unsafe { sys::uxTaskGetStackHighWaterMark(std::ptr::null_mut()) };
                if free < self.lowest_stack_free {
                    self.lowest_stack_free = free;
                    log::info!("TLS PCM stack minimum free: {free} bytes");
                }
                Ok(Connection::Tls(stream, quiet))
            }
        }
    }
}

impl PcmStream<TcpSendError> for Connection {
    fn send_all(&mut self, bytes: &[u8]) -> std::result::Result<(), TcpSendError> {
        match self {
            Self::Cleartext(stream) => stream.write_all(bytes).map_err(TcpSendError::io),
            Self::Tls(stream, _) => stream.write_all(bytes).map_err(TcpSendError::io),
        }
    }
}

/// ESP-TLS and its mbedTLS port log every failed connect, handshake, read and
/// write under these tags.
const ESP_TLS_LOG_TAGS: [&CStr; 3] = [c"esp-tls", c"esp-tls-mbedtls", c"Dynamic Impl"];

/// Turns ESP-TLS's own logging off while the sender opens or holds a
/// connection. The sender names each failure from the ESP-TLS error record,
/// and its failure run decides which attempts reach the log. Update checks
/// pause the sender before they connect, so their ESP-TLS errors still log.
struct QuietEspTls;

impl QuietEspTls {
    fn new() -> Self {
        for tag in ESP_TLS_LOG_TAGS {
            unsafe { sys::esp_log_level_set(tag.as_ptr(), sys::esp_log_level_t_ESP_LOG_NONE) };
        }
        Self
    }
}

impl Drop for QuietEspTls {
    fn drop(&mut self) {
        // A null tag reads the default level, which these tags otherwise use.
        let level = unsafe { sys::esp_log_level_get(std::ptr::null()) };
        for tag in ESP_TLS_LOG_TAGS {
            unsafe { sys::esp_log_level_set(tag.as_ptr(), level) };
        }
    }
}

struct TlsConnection {
    handle: *mut sys::esp_tls_t,
    _key: Box<TransportKey>,
    _identity: CString,
    _psk: Box<sys::psk_key_hint>,
}

impl TlsConnection {
    fn connect(target: SocketAddr, key: TransportKey) -> Result<Self> {
        let hostname = CString::new(target.ip().to_string())?;
        let key = Box::new(key);
        let identity = CString::new(key.identity())?;
        let psk = Box::new(sys::psk_key_hint {
            key: key.psk().as_bytes().as_ptr(),
            key_size: key.psk().as_bytes().len(),
            hint: identity.as_ptr(),
        });
        let config = sys::esp_tls_cfg_t {
            timeout_ms: TLS_TIMEOUT_MS,
            psk_hint_key: &*psk,
            ciphersuites_list: TLS_CIPHERSUITES.as_ptr(),
            tls_version: sys::esp_tls_proto_ver_t_ESP_TLS_VER_TLS_1_3,
            addr_family: sys::esp_tls_addr_family_ESP_TLS_AF_INET,
            ..Default::default()
        };
        let handle = unsafe { sys::esp_tls_init() };
        if handle.is_null() {
            return Err(anyhow!("cannot allocate ESP-TLS handle"));
        }
        let result = unsafe {
            sys::esp_tls_conn_new_sync(
                hostname.as_ptr(),
                hostname.as_bytes().len() as i32,
                i32::from(target.port()),
                &config,
                handle,
            )
        };
        if result != 1 {
            let failure = classify_failure(handle);
            unsafe { sys::esp_tls_conn_destroy(handle) };
            return Err(anyhow!("{}", failure.describe(&target)));
        }
        if let Err(error) = validate_tls_profile(handle).and_then(|()| configure_tls_socket(handle))
        {
            unsafe { sys::esp_tls_conn_destroy(handle) };
            return Err(error);
        }
        Ok(Self {
            handle,
            _key: key,
            _identity: identity,
            _psk: psk,
        })
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        write_all_with(bytes, |remaining| {
            let written = unsafe {
                sys::esp_tls_conn_write(self.handle, remaining.as_ptr().cast(), remaining.len())
            };
            if written < 0 {
                Err(anyhow!("TLS PCM send failed ({written})"))
            } else {
                Ok(written as usize)
            }
        })
        .map_err(|error| match error {
            WriteAllError::Write(error) => error,
            WriteAllError::Closed => anyhow!("TLS PCM stream closed during write"),
        })
    }
}

/// The host-testable classifier mirrors the binding constants numerically;
/// any drift between the two fails this build.
const _: () = {
    use crate::transport_diagnostics::tls_codes as codes;
    assert!(
        sys::ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME
            == codes::ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME
    );
    assert!(
        sys::ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET == codes::ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET
    );
    assert!(
        sys::ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST
            == codes::ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST
    );
    assert!(sys::ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT == codes::ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT);
    assert!(sys::ESP_ERR_ESP_TLS_TCP_CLOSED_FIN == codes::ESP_ERR_ESP_TLS_TCP_CLOSED_FIN);
    assert!(
        sys::ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT
            == codes::ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT
    );
    assert!(sys::MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE == codes::MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE);
    assert!(sys::MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE == codes::MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE);
    assert!(sys::MBEDTLS_ERR_SSL_CONN_EOF == codes::MBEDTLS_ERR_SSL_CONN_EOF);
    assert!(sys::MBEDTLS_ERR_SSL_INVALID_RECORD == codes::MBEDTLS_ERR_SSL_INVALID_RECORD);
    assert!(sys::MBEDTLS_ERR_SSL_UNEXPECTED_MESSAGE == codes::MBEDTLS_ERR_SSL_UNEXPECTED_MESSAGE);
    assert!(sys::MBEDTLS_ERR_SSL_TIMEOUT == codes::MBEDTLS_ERR_SSL_TIMEOUT);
    assert!(sys::ECONNRESET as i32 == codes::ECONNRESET);
    assert!(sys::ECONNREFUSED as i32 == codes::ECONNREFUSED);
};

/// Read the captured error of a failed connect through the public esp-tls
/// accessor — never the record struct's layout — and classify it in the
/// host-testable core.
fn classify_failure(handle: *mut sys::esp_tls_t) -> TlsFailure {
    let mut error_handle: sys::esp_tls_error_handle_t = std::ptr::null_mut();
    let mut last_error: i32 = 0;
    let mut captured_stack: i32 = 0;
    let mut certificate_flags: i32 = 0;
    let mut socket_error: i32 = 0;
    if unsafe { sys::esp_tls_get_error_handle(handle, &mut error_handle) } == 0
        && !error_handle.is_null()
    {
        last_error = unsafe {
            sys::esp_tls_get_and_clear_last_error(
                error_handle,
                &mut captured_stack,
                &mut certificate_flags,
            )
        };
        // The errno sits outside the record the call above returns.
        unsafe {
            sys::esp_tls_get_and_clear_error_type(
                error_handle,
                sys::esp_tls_error_type_t_ESP_TLS_ERR_TYPE_SYSTEM,
                &mut socket_error,
            )
        };
    }
    crate::transport_diagnostics::classify_tls_failure(last_error, captured_stack, socket_error)
}

/// Apply the PCM socket options to the socket ESP-TLS opened.
///
/// Partial batches must flush even when capture stops. ESP-TLS exposes no
/// configuration for this, so set the option on the socket it owns.
fn configure_tls_socket(handle: *mut sys::esp_tls_t) -> Result<()> {
    let mut socket: core::ffi::c_int = -1;
    if unsafe { sys::esp_tls_get_conn_sockfd(handle, &mut socket) } != sys::ESP_OK {
        return Err(anyhow!("TLS connection exposes no socket"));
    }
    let enabled: core::ffi::c_int = 1;
    let result = unsafe {
        sys::lwip_setsockopt(
            socket,
            sys::IPPROTO_TCP as core::ffi::c_int,
            sys::TCP_NODELAY as core::ffi::c_int,
            (&enabled as *const core::ffi::c_int).cast(),
            core::mem::size_of_val(&enabled) as sys::socklen_t,
        )
    };
    if result != 0 {
        return Err(anyhow!("cannot disable Nagle on the TLS socket"));
    }
    set_media_priority(socket)
}

/// Request ESP-IDF's Wi-Fi media queue for the PCM connection.
fn set_media_priority(socket: core::ffi::c_int) -> Result<()> {
    let priority: core::ffi::c_int = 4 << 5;
    let result = unsafe {
        sys::lwip_setsockopt(
            socket,
            sys::IPPROTO_IP as core::ffi::c_int,
            sys::IP_TOS as core::ffi::c_int,
            (&priority as *const core::ffi::c_int).cast(),
            core::mem::size_of_val(&priority) as sys::socklen_t,
        )
    };
    if result != 0 {
        return Err(anyhow!("cannot set PCM socket media priority"));
    }
    Ok(())
}

fn validate_tls_profile(handle: *mut sys::esp_tls_t) -> Result<()> {
    let context = unsafe { sys::esp_tls_get_ssl_context(handle) };
    if context.is_null() {
        return Err(anyhow!("TLS connection has no Mbed TLS context"));
    }
    let ssl = context.cast::<sys::mbedtls_ssl_context>();
    let version = unsafe { sys::mbedtls_ssl_get_version(ssl) };
    let ciphersuite = unsafe { sys::mbedtls_ssl_get_ciphersuite(ssl) };
    if version.is_null() || ciphersuite.is_null() {
        return Err(anyhow!("TLS connection has no negotiated profile"));
    }
    if unsafe { CStr::from_ptr(version) }.to_bytes() != TLS_VERSION
        || unsafe { CStr::from_ptr(ciphersuite) }.to_bytes() != TLS_CIPHERSUITE
    {
        return Err(anyhow!("bridge negotiated an unsupported TLS profile"));
    }
    if !unsafe { sys::mbedtls_ssl_get_peer_cert(ssl) }.is_null() {
        return Err(anyhow!(
            "bridge did not authenticate with the transport PSK"
        ));
    }
    let payload_capacity = unsafe { sys::mbedtls_ssl_get_max_out_record_payload(ssl) };
    if payload_capacity < crate::stream::MAX_BATCH_BYTES as i32 {
        return Err(anyhow!(
            "TLS outgoing payload capacity {payload_capacity} cannot hold a PCM send batch"
        ));
    }
    Ok(())
}

impl Drop for TlsConnection {
    fn drop(&mut self) {
        unsafe { sys::esp_tls_conn_destroy(self.handle) };
    }
}

pub struct TlsKeyVerifier;

impl KeyVerifier for TlsKeyVerifier {
    fn verify(&self, host: &str, port: u16, key: &TransportKey) -> std::result::Result<(), String> {
        let target = resolve_socket(host, port).map_err(|error| error.to_string())?;
        TlsConnection::connect(target, key.clone())
            .map(drop)
            .map_err(|error| error.to_string())
    }
}

fn resolve_socket(host: &str, port: u16) -> Result<SocketAddr> {
    (host, port)
        .to_socket_addrs()
        .with_context(|| format!("cannot resolve PCM target {host}:{port}"))?
        .next()
        .ok_or_else(|| anyhow!("PCM target {host}:{port} resolved to no addresses"))
}
