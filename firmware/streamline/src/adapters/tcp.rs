//! Bounded TCP transport for the real-time streaming task.
//!
//! ESP-IDF backs `std::net` with the same lwIP stack the firmware would
//! otherwise drive through raw FFI, so the standard library gives us a
//! connect timeout, `TCP_NODELAY`, and a bounded send deadline without any
//! `unsafe` socket handling.

use std::{
    io::Write,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    time::Duration,
};

use anyhow::{anyhow, Context, Result};

use crate::config::RuntimeConfig;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
const SEND_TIMEOUT: Duration = Duration::from_millis(250);

/// A resolved bridge endpoint. Resolution happens once before capture starts so
/// DNS work never lands in the streaming hot path.
#[derive(Clone, Copy)]
pub struct TargetAddress(SocketAddr);

impl TargetAddress {
    pub fn resolve(config: &RuntimeConfig) -> Result<Self> {
        (config.target_host.as_str(), config.target_port)
            .to_socket_addrs()
            .with_context(|| {
                format!(
                    "cannot resolve TCP target {}:{}",
                    config.target_host, config.target_port
                )
            })?
            .next()
            .map(Self)
            .ok_or_else(|| {
                anyhow!(
                    "TCP target {}:{} resolved to no addresses",
                    config.target_host,
                    config.target_port
                )
            })
    }
}

/// A lazily-connected, drop-on-error TCP sender. The streaming task calls
/// [`TcpClient::send_all`] for every packet; the first call, and the first
/// after any failure, reconnects transparently.
pub struct TcpClient {
    target: TargetAddress,
    stream: Option<TcpStream>,
}

impl TcpClient {
    pub const fn new(target: TargetAddress) -> Self {
        Self {
            target,
            stream: None,
        }
    }

    /// Sends the whole buffer, opening a connection first if needed. Returns
    /// `true` when this call had to establish a fresh connection, letting the
    /// caller account for reconnects. On any I/O error the connection is
    /// dropped so the next call starts clean.
    pub fn send_all(&mut self, bytes: &[u8]) -> Result<bool> {
        let connected = self.connect_if_needed()?;
        let stream = self.stream.as_mut().expect("connected just above");
        if let Err(error) = stream.write_all(bytes) {
            self.stream = None;
            return Err(anyhow!("TCP send failed: {error}"));
        }
        Ok(connected)
    }

    fn connect_if_needed(&mut self) -> Result<bool> {
        if self.stream.is_some() {
            return Ok(false);
        }
        let stream = TcpStream::connect_timeout(&self.target.0, CONNECT_TIMEOUT)
            .with_context(|| format!("TCP connect to {} failed", self.target.0))?;
        stream.set_nodelay(true)?;
        stream.set_write_timeout(Some(SEND_TIMEOUT))?;
        self.stream = Some(stream);
        Ok(true)
    }
}
