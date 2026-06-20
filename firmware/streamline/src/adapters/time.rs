//! SNTP synchronization required before validating HTTPS certificates.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{bail, Result};
use esp_idf_svc::sys;

const NTP_SERVER: &core::ffi::CStr = c"pool.ntp.org";
const SYNC_TIMEOUT_SECONDS: u32 = 45;

static STARTED: AtomicBool = AtomicBool::new(false);

/// Start SNTP after station Wi-Fi has an address.
pub fn start() -> Result<()> {
    if STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }

    let mut config = sys::esp_sntp_config_t::default();
    config.wait_for_sync = true;
    config.start = true;
    config.num_of_servers = 1;
    config.servers[0] = NTP_SERVER.as_ptr();

    let result = unsafe { sys::esp_netif_sntp_init(&config) };
    if result == sys::ESP_OK {
        log::info!("SNTP started with pool.ntp.org");
        Ok(())
    } else {
        STARTED.store(false, Ordering::Release);
        bail!("cannot start SNTP: ESP error {result}")
    }
}

/// Wait until SNTP has set a wall clock suitable for HTTPS certificate checks.
pub fn wait_for_sync() -> Result<()> {
    if !STARTED.load(Ordering::Acquire) {
        bail!("SNTP is not running")
    }

    let restart = unsafe { sys::esp_netif_sntp_start() };
    if restart != sys::ESP_OK {
        bail!("cannot restart SNTP: ESP error {restart}")
    }

    for _ in 0..SYNC_TIMEOUT_SECONDS {
        let result = unsafe { sys::esp_netif_sntp_sync_wait(sys::CONFIG_FREERTOS_HZ) };
        if result == sys::ESP_OK {
            log::info!("SNTP time synchronized");
            return Ok(());
        }
        if result != sys::ESP_ERR_TIMEOUT {
            bail!("SNTP synchronization failed: ESP error {result}")
        }
    }

    bail!("time synchronization timed out after {SYNC_TIMEOUT_SECONDS} s")
}
