//! ESP-IDF Wi-Fi ownership and mode transitions.

use core::{convert::TryInto, ffi::CStr};
use std::net::Ipv4Addr;

use anyhow::{anyhow, Context, Result};
use embedded_svc::wifi::{
    AccessPointConfiguration, AuthMethod, ClientConfiguration, Configuration,
};
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::{delay::FreeRtos, modem::Modem},
    nvs::EspDefaultNvsPartition,
    sys::{
        esp_netif_dhcp_option_id_t_ESP_NETIF_DOMAIN_NAME_SERVER,
        esp_netif_dhcp_option_mode_t_ESP_NETIF_OP_SET, esp_netif_dhcps_option,
        esp_netif_dhcps_start, esp_netif_dhcps_stop, esp_netif_dns_info_t,
        esp_netif_dns_type_t_ESP_NETIF_DNS_MAIN, esp_netif_get_handle_from_ifkey,
        esp_netif_get_ip_info, esp_netif_ip_info_t, esp_netif_set_dns_info, esp_wifi_set_ps,
        esp_wifi_sta_get_ap_info, wifi_ap_record_t, wifi_ps_type_t_WIFI_PS_NONE, EspError,
        ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED, ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED,
        ESP_IPADDR_TYPE_V4, ESP_OK,
    },
    wifi::{BlockingWifi, EspWifi},
};

use crate::{config::RuntimeConfig, identity, setup_network::SetupNetwork};

pub type WifiController<'d> = BlockingWifi<EspWifi<'d>>;

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

/// Bounded poll for the soft-AP address when the framework's blocking wait
/// cannot be used because the station shares the radio (recovery mode). About
/// five seconds total.
const AP_READY_POLLS: u32 = 50;
const AP_READY_POLL_INTERVAL_MS: u32 = 100;
/// Bounded poll for the station address after a recovery association attempt,
/// covering the DHCP lease. About five seconds total.
const STATION_READY_POLLS: u32 = 50;
const STATION_READY_POLL_INTERVAL_MS: u32 = 100;

/// The saved home network as a station configuration, shared by the initial
/// connect and the recovery retry.
fn station_config(config: &RuntimeConfig) -> Result<ClientConfiguration> {
    Ok(ClientConfiguration {
        ssid: config.ssid.as_str().try_into()?,
        bssid: None,
        auth_method: AuthMethod::WPA2Personal,
        password: config.password.as_str().try_into()?,
        channel: None,
        ..Default::default()
    })
}

/// Start the radio with modem sleep off.
///
/// ESP-IDF defaults a station to `WIFI_PS_MIN_MODEM`, which parks the radio
/// between DTIM beacons. That trades round-trip time for power: latency rises
/// into the tens of milliseconds and TCP throughput, bounded by the send window
/// over the round trip, falls below the bitrate a 48 kHz stereo capture
/// produces — so the packet queue overflows and the stream loses audio. This
/// device is mains-powered and streams continuously, so it keeps the radio
/// awake. `esp_wifi_set_ps` applies to the station and is inert in AP-only
/// setup, so every start path can share one call.
fn start_radio(wifi: &mut WifiController<'_>) -> Result<()> {
    wifi.start()?;
    esp_error(unsafe { esp_wifi_set_ps(wifi_ps_type_t_WIFI_PS_NONE) })
        .context("disable Wi-Fi power save")
}

pub fn connect_station(wifi: &mut WifiController<'_>, config: &RuntimeConfig) -> Result<()> {
    wifi.set_configuration(&Configuration::Client(station_config(config)?))?;
    start_radio(wifi)?;

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

/// Start the physical-presence setup network, WPA2-protected by the
/// device-generated password. Joining it requires the password from the
/// device's serial log, the flasher, or its label, so commissioning is
/// anchored to possession of the board. The AP runs only in setup and
/// recovery, never while the device is on its home network.
pub fn start_setup_ap(wifi: &mut WifiController<'_>, network: &SetupNetwork) -> Result<()> {
    start_ap(wifi, network, None)
}

/// Start the setup AP alongside a station that keeps retrying the saved Wi-Fi.
/// A provisioned device that fell back to recovery runs both interfaces, so the
/// owner keeps a reachable console while the device rejoins its home network on
/// its own through repeated [`reconnect_station`] calls. The AP stays up whether
/// or not the station associates.
pub fn start_recovery_ap(
    wifi: &mut WifiController<'_>,
    network: &SetupNetwork,
    config: &RuntimeConfig,
) -> Result<()> {
    start_ap(wifi, network, Some(config))
}

fn start_ap(
    wifi: &mut WifiController<'_>,
    network: &SetupNetwork,
    station: Option<&RuntimeConfig>,
) -> Result<()> {
    let access_point = AccessPointConfiguration {
        ssid: network.ssid.as_str().try_into()?,
        ssid_hidden: false,
        auth_method: AuthMethod::WPA2Personal,
        password: network.password.as_str().try_into()?,
        channel: 1,
        ..Default::default()
    };
    let configuration = match station {
        Some(config) => Configuration::Mixed(station_config(config)?, access_point),
        None => Configuration::AccessPoint(access_point),
    };

    wifi.set_configuration(&configuration)?;
    start_radio(wifi)?;
    wait_access_point_ready(wifi, station.is_none())?;
    if let Err(error) = advertise_setup_dns() {
        log::warn!("setup DHCP DNS advertisement unavailable: {error:#}");
    }
    Ok(())
}

/// Wait for the soft-AP interface to obtain its address before advertising DNS.
///
/// In AP-only setup the framework's blocking wait suffices. In recovery the
/// station is configured but not yet connected, so `wait_netif_up` could block
/// on the station link; poll the AP address directly instead.
fn wait_access_point_ready(wifi: &mut WifiController<'_>, ap_only: bool) -> Result<()> {
    if ap_only {
        wifi.wait_netif_up()?;
        return Ok(());
    }
    for _ in 0..AP_READY_POLLS {
        if access_point_address().is_some() {
            return Ok(());
        }
        FreeRtos::delay_ms(AP_READY_POLL_INTERVAL_MS);
    }
    Err(anyhow!("setup AP address did not come up"))
}

/// Drive one station association attempt without tearing down the setup AP.
///
/// The combined AP-and-station configuration is already set by
/// [`start_recovery_ap`], so this only initiates association and reports whether
/// the station obtained an address. A failure leaves the AP up for the next
/// attempt; success means the home network is reachable again.
pub fn reconnect_station(wifi: &mut WifiController<'_>) -> bool {
    // A prior attempt may have associated but leased an address only after its
    // poll window closed; if the station now holds one, the network is back and
    // there is no need to reconnect an already-connected station.
    if station_ip().is_some() {
        return true;
    }
    if let Err(error) = wifi.connect() {
        log::info!("recovery Wi-Fi retry did not associate: {error}");
        return false;
    }
    for _ in 0..STATION_READY_POLLS {
        if station_ip().is_some() {
            return true;
        }
        FreeRtos::delay_ms(STATION_READY_POLL_INTERVAL_MS);
    }
    false
}

/// Make the setup AP's DNS responder authoritative in every DHCP lease.
///
/// ESP-IDF can add the AP address implicitly when no DNS server is configured,
/// but an explicit option survives client and SDK differences. DHCP must be
/// stopped while its advertised DNS address is changed.
fn advertise_setup_dns() -> Result<()> {
    let netif = unsafe { esp_netif_get_handle_from_ifkey(c"WIFI_AP_DEF".as_ptr()) };
    if netif.is_null() {
        return Err(anyhow!("setup AP network interface is unavailable"));
    }

    match unsafe { esp_netif_dhcps_stop(netif) } {
        ESP_OK | ESP_ERR_ESP_NETIF_DHCP_ALREADY_STOPPED => {}
        code => return esp_error(code).context("stop setup DHCP server"),
    }

    let configured = (|| {
        let mut offer_dns = 1_u8;
        esp_error(unsafe {
            esp_netif_dhcps_option(
                netif,
                esp_netif_dhcp_option_mode_t_ESP_NETIF_OP_SET,
                esp_netif_dhcp_option_id_t_ESP_NETIF_DOMAIN_NAME_SERVER,
                (&mut offer_dns as *mut u8).cast(),
                core::mem::size_of_val(&offer_dns) as u32,
            )
        })
        .context("enable setup DHCP DNS option")?;

        let mut ip_info: esp_netif_ip_info_t = unsafe { core::mem::zeroed() };
        esp_error(unsafe { esp_netif_get_ip_info(netif, &mut ip_info) })
            .context("read setup AP address")?;
        let mut dns: esp_netif_dns_info_t = unsafe { core::mem::zeroed() };
        dns.ip.u_addr.ip4 = ip_info.ip;
        dns.ip.type_ = ESP_IPADDR_TYPE_V4 as u8;
        esp_error(unsafe {
            esp_netif_set_dns_info(netif, esp_netif_dns_type_t_ESP_NETIF_DNS_MAIN, &mut dns)
        })
        .context("set setup DHCP DNS server")
    })();

    let restarted = match unsafe { esp_netif_dhcps_start(netif) } {
        ESP_OK | ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED => Ok(()),
        code => esp_error(code).context("restart setup DHCP server"),
    };
    configured?;
    restarted?;
    log::info!("setup DHCP advertises the AP as DNS");
    Ok(())
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
    interface_ipv4(c"WIFI_STA_DEF").map(|address| address.to_string())
}

/// Dotted IPv4 of the soft-AP interface, or `None` when the AP is not up.
pub fn access_point_ip() -> Option<String> {
    access_point_address().map(|address| address.to_string())
}

/// IPv4 of the soft-AP interface, or `None` when the AP is not up.
pub fn access_point_address() -> Option<Ipv4Addr> {
    interface_ipv4(c"WIFI_AP_DEF")
}

fn interface_ipv4(key: &CStr) -> Option<Ipv4Addr> {
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
    Some(Ipv4Addr::from(info.ip.addr.to_le_bytes()))
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
