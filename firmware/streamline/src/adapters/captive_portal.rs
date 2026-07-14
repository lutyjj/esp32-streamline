//! Setup-AP DNS service for captive-network discovery.

use std::{
    io::ErrorKind,
    net::{Ipv4Addr, SocketAddrV4, UdpSocket},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use anyhow::{Context, Result};

use crate::captive_portal;

const DNS_PORT: u16 = 53;
const PACKET_BYTES: usize = 512;
const TASK_STACK_BYTES: usize = 4_096;
const RECEIVE_TIMEOUT: Duration = Duration::from_millis(250);

/// A setup-only DNS worker. Dropping it stops the responder task.
pub struct DnsResponder {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl DnsResponder {
    pub fn start(address: Ipv4Addr) -> Result<Self> {
        let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, DNS_PORT))
            .context("bind setup DNS responder to UDP port 53")?;
        socket
            .set_read_timeout(Some(RECEIVE_TIMEOUT))
            .context("set setup DNS receive timeout")?;

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("portal-dns".to_owned())
            .stack_size(TASK_STACK_BYTES)
            .spawn(move || serve(socket, address, &worker_stop))
            .context("spawn setup DNS responder")?;

        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for DnsResponder {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                log::warn!("setup DNS responder panicked during shutdown");
            }
        }
    }
}

fn serve(socket: UdpSocket, address: Ipv4Addr, stop: &AtomicBool) {
    let mut request = [0_u8; PACKET_BYTES];
    let mut response = [0_u8; PACKET_BYTES];
    while !stop.load(Ordering::Acquire) {
        match socket.recv_from(&mut request) {
            Ok((request_len, peer)) => {
                let Some(response_len) =
                    captive_portal::dns_reply(&request[..request_len], address, &mut response)
                else {
                    log::debug!("ignored unsupported setup DNS query from {peer}");
                    continue;
                };
                match socket.send_to(&response[..response_len], peer) {
                    Ok(_) => log::info!("answered setup DNS query from {peer} with {address}"),
                    Err(error) => {
                        log::warn!("could not answer setup DNS query from {peer}: {error}")
                    }
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => {
                log::warn!("setup DNS responder stopped: {error}");
                return;
            }
        }
    }
}
