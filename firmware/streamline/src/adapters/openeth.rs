//! Emulated-network bring-up for the `qemu` image variant.
//!
//! QEMU emulates no Wi-Fi PHY, so the QEMU variant reaches the network
//! through the OpenCores Ethernet MAC that `-nic user,model=open_eth`
//! provides. Requires `CONFIG_ETH_USE_OPENETH` in sdkconfig; the hardware
//! image never constructs this driver and the linker drops it there.
//!
//! A software restart is out of contract under QEMU: the emulated NIC's
//! interrupt state survives a warm CPU reset (unlike real hardware, where
//! `esp_restart` resets peripherals), and the stale interrupt crashes the
//! next boot during early init — `esp_eth_stop` before the reset does not
//! clear it. The smoke harness therefore runs QEMU with `-no-reboot` and
//! treats every boot as a fresh QEMU process over the persistent flash file.

use anyhow::Result;
use esp_idf_svc::{
    eth::{BlockingEth, EspEth, EthDriver, OpenEth},
    eventloop::EspSystemEventLoop,
    hal::mac::MAC,
};

/// The live emulated connection. Dropping it tears the netif down, so the
/// composition root must hold it for the life of the program.
pub type EthConnection = BlockingEth<EspEth<'static, OpenEth>>;

/// Start the emulated NIC and block until DHCP (answered by QEMU's user-mode
/// network) brings the netif up, mirroring the Wi-Fi `wait_netif_up` contract.
pub fn start(mac: MAC<'static>, sysloop: EspSystemEventLoop) -> Result<EthConnection> {
    let driver = EthDriver::new_openeth(mac, sysloop.clone())?;
    let mut ethernet = BlockingEth::wrap(EspEth::wrap(driver)?, sysloop)?;
    ethernet.start()?;
    ethernet.wait_netif_up()?;
    log::info!("emulated ethernet up");
    Ok(ethernet)
}
