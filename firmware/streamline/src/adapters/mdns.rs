//! mDNS advertisement for the embedded web console.

use anyhow::{Context, Result};
use esp_idf_svc::mdns::EspMdns;

use crate::config::RuntimeConfig;

const HTTP_SERVICE: &str = "_http";
const TCP_PROTO: &str = "_tcp";
const HTTP_PORT: u16 = 80;
const DEFAULT_INSTANCE: &str = "StreamLine";

pub struct MdnsAdvertisement {
    mdns: EspMdns,
}

impl MdnsAdvertisement {
    pub fn start(hostname: &str, config: &RuntimeConfig) -> Result<Self> {
        let mut mdns = EspMdns::take().context("initialize mDNS")?;
        mdns.set_hostname(hostname).context("set mDNS hostname")?;
        let instance = instance_name(config);
        mdns.set_instance_name(&instance)
            .context("set mDNS instance name")?;
        mdns.add_service(
            Some(&instance),
            HTTP_SERVICE,
            TCP_PROTO,
            HTTP_PORT,
            &[("path", "/")],
        )
        .context("advertise HTTP service over mDNS")?;
        log::info!("mDNS advertised http://{hostname}.local/ as \"{instance}\"");
        Ok(Self { mdns })
    }

    pub fn set_instance_name(&mut self, config: &RuntimeConfig) -> Result<()> {
        let instance = instance_name(config);
        self.mdns
            .set_instance_name(&instance)
            .context("set mDNS instance name")?;
        self.mdns
            .set_service_instance_name(HTTP_SERVICE, TCP_PROTO, &instance)
            .context("set HTTP service instance name")?;
        log::info!("mDNS instance name set to \"{instance}\"");
        Ok(())
    }
}

fn instance_name(config: &RuntimeConfig) -> String {
    let name = config.device_name.trim();
    if name.is_empty() {
        DEFAULT_INSTANCE.to_owned()
    } else {
        name.to_owned()
    }
}
