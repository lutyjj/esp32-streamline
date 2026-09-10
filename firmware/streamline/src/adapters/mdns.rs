//! mDNS advertisement for the embedded web console.

use anyhow::{Context, Result};
use esp_idf_svc::mdns::EspMdns;

use crate::identity::mdns_instance_name;

const HTTP_SERVICE: &str = "_http";
const TCP_PROTO: &str = "_tcp";
const HTTP_PORT: u16 = 80;

pub struct MdnsAdvertisement {
    mdns: EspMdns,
}

impl MdnsAdvertisement {
    pub fn start(hostname: &str, display_name: &str) -> Result<Self> {
        let mut mdns = EspMdns::take().context("initialize mDNS")?;
        mdns.set_hostname(hostname).context("set mDNS hostname")?;
        let instance = mdns_instance_name(display_name);
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

    pub fn set_instance_name(&mut self, display_name: &str) -> Result<()> {
        let instance = mdns_instance_name(display_name);
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
