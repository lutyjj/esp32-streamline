//! Bounded cleartext or TLS 1.3 PSK transport for the streaming task.

use std::{
    ffi::CString,
    io::Write,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use esp_idf_svc::sys;

use crate::{
    config::RuntimeConfig,
    transport::{KeyVerifier, TransportKey, TransportMode},
};

const CLEARTEXT_TIMEOUT: Duration = Duration::from_millis(250);
const TLS_TIMEOUT_MS: i32 = 2_000;
const TLS_CIPHERSUITES: [i32; 2] = [sys::MBEDTLS_TLS1_3_AES_128_GCM_SHA256 as i32, 0];

#[derive(Clone)]
enum TransportSecurity {
    Cleartext,
    TlsPsk(TransportKey),
}

/// A resolved bridge endpoint and the exact transport selected at boot.
#[derive(Clone)]
pub struct TargetAddress {
    socket: SocketAddr,
    security: TransportSecurity,
}

impl TargetAddress {
    pub fn resolve(config: &RuntimeConfig) -> Result<Self> {
        let port = config.transport.effective_port(config.target_port);
        let socket = resolve_socket(&config.target_host, port)?;
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
        Ok(Self { socket, security })
    }
}

/// A lazily connected sender. Any I/O or authentication failure drops the
/// connection; secure mode never retries against the cleartext listener.
pub struct TcpClient {
    target: TargetAddress,
    connection: Option<Connection>,
}

enum Connection {
    Cleartext(TcpStream),
    Tls(TlsConnection),
}

impl TcpClient {
    pub const fn new(target: TargetAddress) -> Self {
        Self {
            target,
            connection: None,
        }
    }

    pub fn send_all(&mut self, bytes: &[u8]) -> Result<bool> {
        let connected = self.connect_if_needed()?;
        let result = match self.connection.as_mut().expect("connected just above") {
            Connection::Cleartext(stream) => stream.write_all(bytes).map_err(anyhow::Error::from),
            Connection::Tls(stream) => stream.write_all(bytes),
        };
        if let Err(error) = result {
            self.connection = None;
            return Err(error);
        }
        Ok(connected)
    }

    fn connect_if_needed(&mut self) -> Result<bool> {
        if self.connection.is_some() {
            return Ok(false);
        }
        let connection = match &self.target.security {
            TransportSecurity::Cleartext => {
                let stream = TcpStream::connect_timeout(&self.target.socket, CLEARTEXT_TIMEOUT)
                    .with_context(|| format!("TCP connect to {} failed", self.target.socket))?;
                stream.set_nodelay(true)?;
                stream.set_write_timeout(Some(CLEARTEXT_TIMEOUT))?;
                Connection::Cleartext(stream)
            }
            TransportSecurity::TlsPsk(key) => {
                Connection::Tls(TlsConnection::connect(self.target.socket, key.clone())?)
            }
        };
        self.connection = Some(connection);
        Ok(true)
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
        let mut config = sys::esp_tls_cfg_t::default();
        config.timeout_ms = TLS_TIMEOUT_MS;
        config.psk_hint_key = &*psk;
        config.ciphersuites_list = TLS_CIPHERSUITES.as_ptr();
        config.tls_version = sys::esp_tls_proto_ver_t_ESP_TLS_VER_TLS_1_3;
        config.addr_family = sys::esp_tls_addr_family_ESP_TLS_AF_INET;
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
            unsafe { sys::esp_tls_conn_destroy(handle) };
            return Err(anyhow!("TLS 1.3 PSK authentication failed ({result})"));
        }
        Ok(Self {
            handle,
            _key: key,
            _identity: identity,
            _psk: psk,
        })
    }

    fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        let mut sent = 0;
        while sent < bytes.len() {
            let written = unsafe {
                sys::esp_tls_conn_write(
                    self.handle,
                    bytes[sent..].as_ptr().cast(),
                    bytes.len() - sent,
                )
            };
            if written <= 0 {
                return Err(anyhow!("TLS PCM send failed ({written})"));
            }
            sent += written as usize;
        }
        Ok(())
    }
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
