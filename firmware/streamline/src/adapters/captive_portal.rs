//! Setup-only DNS responder that directs clients to the local console.

use std::{
    io::ErrorKind,
    net::{Ipv4Addr, UdpSocket},
    thread,
    time::Duration,
};

use anyhow::{Context, Result};
use esp_idf_svc::hal::task::thread::ThreadSpawnConfiguration;

use crate::captive_portal;

const DNS_PORT: u16 = 53;
const DNS_PACKET_BYTES: usize = 512;
const TASK_STACK_BYTES: usize = 4_096;
const RECEIVE_TIMEOUT: Duration = Duration::from_secs(1);

/// Start the setup DNS responder. Setup mode ends by rebooting into station
/// mode, so the task ends with the process and cannot affect the home network.
pub fn start_dns_responder(address: Ipv4Addr) -> Result<()> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, DNS_PORT))
        .context("bind setup DNS responder to UDP port 53")?;
    socket
        .set_read_timeout(Some(RECEIVE_TIMEOUT))
        .context("set setup DNS receive timeout")?;

    ThreadSpawnConfiguration {
        name: Some(c"portal-dns"),
        stack_size: TASK_STACK_BYTES,
        ..Default::default()
    }
    .set()
    .context("cannot configure setup DNS task")?;
    let spawned = thread::Builder::new()
        .stack_size(TASK_STACK_BYTES)
        .spawn(move || serve_dns(socket, address))
        .context("cannot spawn setup DNS task");
    ThreadSpawnConfiguration::default()
        .set()
        .context("cannot restore default task configuration")?;
    spawned.map(drop)
}

fn serve_dns(socket: UdpSocket, address: Ipv4Addr) {
    let mut request = [0_u8; DNS_PACKET_BYTES];
    loop {
        match socket.recv_from(&mut request) {
            Ok((length, peer)) => {
                let Some(response) = captive_portal::dns_response(&request[..length], address)
                else {
                    log::debug!("ignored malformed setup DNS request from {peer}");
                    continue;
                };
                if let Err(error) = socket.send_to(&response, peer) {
                    log::warn!("could not answer setup DNS request from {peer}: {error}");
                } else {
                    log::info!("setup DNS redirected {peer} to {address}");
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(error) => {
                log::warn!("setup DNS responder stopped: {error}");
                return;
            }
        }
    }
}
