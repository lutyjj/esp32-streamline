//! ESP-IDF Wi-Fi ownership and mode transitions.

use core::{convert::TryInto, ffi::CStr};
use std::{ffi::CString, net::Ipv4Addr};

use anyhow::{anyhow, Context, Result};
use embedded_svc::wifi::{
    AccessPointConfiguration, AuthMethod, ClientConfiguration, Configuration,
};
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{delay::FreeRtos, modem::Modem},
    nvs::EspDefaultNvsPartition,
    sys::{
        esp_netif_dhcp_option_id_t_ESP_NETIF_CAPTIVEPORTAL_URI,
        esp_netif_dhcp_option_mode_t_ESP_NETIF_OP_SET, esp_netif_dhcps_option,
        esp_netif_dhcps_start, esp_netif_dhcps_stop, esp_netif_get_handle_from_ifkey,
        esp_netif_get_ip_info, esp_netif_ip_info_t, esp_netif_set_ip_info,
        esp_wifi_sta_get_ap_info, wifi_ap_record_t, EspError,
        ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED, ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED, ESP_OK,
    },
    wifi::{BlockingWifi, EspWifi},
};

use crate::{captive_portal, config::RuntimeConfig, identity};

pub type WifiController<'d> = BlockingWifi<EspWifi<'d>>;

/// Setup-network facts that remain live while setup-mode services run.
pub struct SetupNetwork {
    ssid: String,
    address: Ipv4Addr,
    dhcp_started: bool,
    /// ESP-IDF stores this pointer for DHCP Option 114 instead of copying the
    /// string, so this owner must live as long as the DHCP server.
    _captive_portal_uri: CString,
}

impl SetupNetwork {
    pub fn ssid(&self) -> &str {
        &self.ssid
    }

    pub fn address(&self) -> Ipv4Addr {
        self.address
    }

    fn mark_dhcp_started(&mut self) {
        self.dhcp_started = true;
    }
}

pub fn create<'d>(
    modem: Modem<'d>,
    system_event_loop: EspSystemEventLoop,
    nvs_partition: EspDefaultNvsPartition,
) -> Result<WifiController<'d>> {
    Ok(BlockingWifi::wrap(
        EspWifi::new(modem, system_event_loop.clone(), Some(nvs_partition))?,
        system_event_loop,
    )?)
}

/// Transient association or DHCP failures are common right after a reboot (the
/// access point still holds state for this MAC), and a setup-AP fallback on a
/// freshly installed OTA image triggers rollback — so one flaky attempt must
/// not decide the boot.
const CONNECT_ATTEMPTS: u32 = 3;
const CONNECT_RETRY_DELAY_MS: u32 = 2_000;

pub fn connect_station(wifi: &mut WifiController<'_>, config: &RuntimeConfig) -> Result<()> {
    let station = Configuration::Client(ClientConfiguration {
        ssid: config.ssid.as_str().try_into()?,
        bssid: None,
        auth_method: AuthMethod::WPA2Personal,
        password: config.password.as_str().try_into()?,
        channel: None,
        ..Default::default()
    });

    wifi.set_configuration(&station)?;
    wifi.start()?;

    let mut attempt = 1;
    loop {
        match wifi.connect().and_then(|()| wifi.wait_netif_up()) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < CONNECT_ATTEMPTS => {
                log::warn!("Wi-Fi connect attempt {attempt}/{CONNECT_ATTEMPTS} failed: {error}");
                let _ = wifi.disconnect();
                FreeRtos::delay_ms(CONNECT_RETRY_DELAY_MS);
                attempt += 1;
            }
            Err(error) => {
                return Err(anyhow::anyhow!(error).context(format!(
                    "Wi-Fi connect failed after {CONNECT_ATTEMPTS} attempts"
                )))
            }
        }
    }
}

/// Start the physical-presence setup network. It is deliberately open because
/// initial configuration has no pre-shared secret; HTTP writes are only enabled
/// in this mode and the AP is never started on a provisioned device.
pub fn start_setup_ap(wifi: &mut WifiController<'_>, suffix: &str) -> Result<SetupNetwork> {
    let ssid = format!("esp32-streamline-{suffix}");
    let access_point = Configuration::AccessPoint(AccessPointConfiguration {
        ssid: ssid.as_str().try_into()?,
        ssid_hidden: false,
        auth_method: AuthMethod::None,
        password: "".try_into()?,
        channel: 1,
        ..Default::default()
    });

    let address = captive_portal::SETUP_ADDRESS;
    let captive_portal_uri = CString::new(captive_portal::console_url(address))?;
    prepare_setup_netif(address, &captive_portal_uri)?;
    wifi.set_configuration(&access_point)?;
    wifi.start()?;
    wifi.wait_netif_up()?;
    stop_setup_dhcp(setup_ap_netif()?)?;
    Ok(SetupNetwork {
        ssid,
        address,
        dhcp_started: false,
        _captive_portal_uri: captive_portal_uri,
    })
}

pub fn start_setup_dhcp(network: &mut SetupNetwork) -> Result<()> {
    if network.dhcp_started {
        return Ok(());
    }
    let netif = setup_ap_netif()?;
    match unsafe { esp_netif_dhcps_start(netif) } {
        ESP_OK | ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED => {
            network.mark_dhcp_started();
            log::info!(
                "setup DHCP advertises captive portal at {}",
                network._captive_portal_uri.to_string_lossy()
            );
            Ok(())
        }
        code => esp_error(code).context("start setup DHCP server"),
    }
}

fn prepare_setup_netif(address: Ipv4Addr, uri: &CString) -> Result<()> {
    let netif = setup_ap_netif()?;
    stop_setup_dhcp(netif)?;
    let ip_info = setup_ip_info(address);
    esp_error(unsafe { esp_netif_set_ip_info(netif, &ip_info) }).context("set setup AP address")?;
    esp_error(unsafe {
        esp_netif_dhcps_option(
            netif,
            esp_netif_dhcp_option_mode_t_ESP_NETIF_OP_SET,
            esp_netif_dhcp_option_id_t_ESP_NETIF_CAPTIVEPORTAL_URI,
            uri.as_ptr().cast_mut().cast(),
            uri.as_bytes().len() as u32,
        )
    })
    .context("set setup DHCP captive portal URI")?;
    Ok(())
}

fn setup_ap_netif() -> Result<*mut esp_idf_svc::sys::esp_netif_obj> {
    let netif = unsafe { esp_netif_get_handle_from_ifkey(c"WIFI_AP_DEF".as_ptr()) };
    if netif.is_null() {
        Err(anyhow!("setup AP network interface is unavailable"))
    } else {
        Ok(netif)
    }
}

fn stop_setup_dhcp(netif: *mut esp_idf_svc::sys::esp_netif_obj) -> Result<()> {
    match unsafe { esp_netif_dhcps_stop(netif) } {
        ESP_OK | ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED => Ok(()),
        code => esp_error(code).context("stop setup DHCP server"),
    }
}

fn setup_ip_info(address: Ipv4Addr) -> esp_netif_ip_info_t {
    let mut info: esp_netif_ip_info_t = unsafe { core::mem::zeroed() };
    info.ip.addr = u32::from_le_bytes(address.octets());
    info.gw.addr = u32::from_le_bytes(address.octets());
    info.netmask.addr = u32::from_le_bytes([255, 255, 255, 0]);
    info
}

fn esp_error(code: i32) -> Result<()> {
    if code == ESP_OK {
        Ok(())
    } else {
        Err(EspError::from(code)
            .expect("ESP-IDF error code is nonzero")
            .into())
    }
}

/// Current station RSSI in dBm, or `None` when not associated.
pub fn rssi() -> Option<i32> {
    let mut record: wifi_ap_record_t = unsafe { core::mem::zeroed() };
    let code = unsafe { esp_wifi_sta_get_ap_info(&mut record) };
    (code == ESP_OK).then_some(i32::from(record.rssi))
}

/// Dotted IPv4 of the station interface, or `None` when it has no address.
pub fn station_ip() -> Option<String> {
    interface_ipv4(c"WIFI_STA_DEF")
}

/// Dotted IPv4 of the soft-AP interface, or `None` when the AP is not up.
pub fn access_point_ip() -> Option<String> {
    interface_ipv4(c"WIFI_AP_DEF")
}

fn interface_ipv4(key: &CStr) -> Option<String> {
    let netif = unsafe { esp_netif_get_handle_from_ifkey(key.as_ptr()) };
    if netif.is_null() {
        return None;
    }
    let mut info: esp_netif_ip_info_t = unsafe { core::mem::zeroed() };
    if unsafe { esp_netif_get_ip_info(netif, &mut info) } != ESP_OK || info.ip.addr == 0 {
        return None;
    }
    // esp_ip4_addr stores the address in network order: the first octet is the
    // least-significant byte on this little-endian target.
    let [a, b, c, d] = info.ip.addr.to_le_bytes();
    Some(format!("{a}.{b}.{c}.{d}"))
}

pub fn device_suffix() -> Result<String> {
    Ok(identity::setup_suffix(default_mac()?))
}

pub fn mdns_hostname() -> Result<String> {
    Ok(identity::mdns_hostname(default_mac()?))
}

fn default_mac() -> Result<[u8; 6]> {
    let mut mac = [0_u8; 6];
    let code = unsafe { esp_idf_svc::sys::esp_efuse_mac_get_default(mac.as_mut_ptr()) };
    if code != esp_idf_svc::sys::ESP_OK {
        return Err(esp_idf_svc::sys::EspError::from(code).unwrap().into());
    }
    Ok(mac)
}
