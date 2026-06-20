//! ESP-IDF Wi-Fi ownership and mode transitions.

use core::convert::TryInto;

use anyhow::Result;
use embedded_svc::wifi::{
    AccessPointConfiguration, AuthMethod, ClientConfiguration, Configuration,
};
use esp_idf_svc::{
    eventloop::EspSystemEventLoop,
    hal::modem::Modem,
    nvs::EspDefaultNvsPartition,
    wifi::{BlockingWifi, EspWifi},
};

use crate::config::RuntimeConfig;

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
    wifi.connect()?;
    wifi.wait_netif_up()?;
    Ok(())
}

/// Start the physical-presence setup network. It is deliberately open because
/// initial configuration has no pre-shared secret; HTTP writes are only enabled
/// in this mode and the AP is never started in normal streaming mode.
pub fn start_setup_ap(wifi: &mut WifiController<'_>, suffix: &str) -> Result<String> {
    let ssid = format!("esp32-streamline-{suffix}");
    let access_point = Configuration::AccessPoint(AccessPointConfiguration {
        ssid: ssid.as_str().try_into()?,
        ssid_hidden: false,
        auth_method: AuthMethod::None,
        password: "".try_into()?,
        channel: 1,
        ..Default::default()
    });

    wifi.set_configuration(&access_point)?;
    wifi.start()?;
    wifi.wait_netif_up()?;
    Ok(ssid)
}
