//! mDNS: advertise the embedded web console and browse for bridges.

use std::{
    ffi::{CStr, CString},
    net::Ipv4Addr,
    time::Instant,
};

use anyhow::{Context, Result};
use esp_idf_svc::{
    mdns::EspMdns,
    sys::{self, esp},
};

use crate::{
    bridge_discovery::{
        Answer, DiscoveredBridge, RecentBrowse, BROWSE_MILLIS, MAX_ANSWERS, PROTO, SERVICE,
    },
    identity::mdns_instance_name,
};

const HTTP_SERVICE: &str = "_http";
const TCP_PROTO: &str = "_tcp";
const HTTP_PORT: u16 = 80;

pub struct Mdns {
    mdns: EspMdns,
    recent: RecentBrowse,
}

impl Mdns {
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
        Ok(Self {
            mdns,
            recent: RecentBrowse::default(),
        })
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

    /// The bridges on the network, from a browse that blocks for its window
    /// unless a recent one answers (see [`RecentBrowse`]).
    pub fn bridges(&mut self) -> Result<Vec<DiscoveredBridge>> {
        self.recent.bridges(Instant::now, browse_bridges)
    }
}

/// Browse once. This calls ESP-IDF directly: `EspMdns::query_ptr` panics on a
/// name or TXT value that is not UTF-8, and any host on the network chooses
/// those bytes. Only a live [`Mdns`] calls it, so the mDNS service is running.
fn browse_bridges() -> Result<Vec<Answer>> {
    let service = CString::new(SERVICE).expect("service has no NUL byte");
    let proto = CString::new(PROTO).expect("protocol has no NUL byte");
    let mut results: *mut sys::mdns_result_t = core::ptr::null_mut();
    esp!(unsafe {
        sys::mdns_query_ptr(
            service.as_ptr(),
            proto.as_ptr(),
            BROWSE_MILLIS,
            MAX_ANSWERS,
            &mut results,
        )
    })
    .context("browse for bridges over mDNS")?;
    // SAFETY: `results` is the list ESP-IDF returned, freed only below.
    let answers = unsafe { copy_answers(results) };
    unsafe { sys::mdns_query_results_free(results) };
    Ok(answers)
}

/// Copy a result list into owned answers.
///
/// # Safety
///
/// `result` is null or the head of a live list from an ESP-IDF mDNS query.
unsafe fn copy_answers(mut result: *const sys::mdns_result_t) -> Vec<Answer> {
    let mut answers = Vec::new();
    while let Some(current) = unsafe { result.as_ref() } {
        answers.push(Answer {
            instance: unsafe { c_bytes(current.instance_name) },
            port: current.port,
            ttl: current.ttl,
            txt: unsafe { txt(current) },
            addresses: unsafe { ipv4_addresses(current.addr) },
        });
        result = current.next;
    }
    answers
}

unsafe fn c_bytes(text: *const core::ffi::c_char) -> Option<Vec<u8>> {
    (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) }.to_bytes().to_vec())
}

/// TXT items with their value bytes, whose lengths ESP-IDF keeps beside them.
unsafe fn txt(result: &sys::mdns_result_t) -> Vec<(Vec<u8>, Option<Vec<u8>>)> {
    if result.txt.is_null() || result.txt_value_len.is_null() {
        return Vec::new();
    }
    (0..result.txt_count)
        .filter_map(|index| {
            let item = unsafe { &*result.txt.add(index) };
            let key = unsafe { c_bytes(item.key) }?;
            let value = (!item.value.is_null()).then(|| {
                let length = usize::from(unsafe { *result.txt_value_len.add(index) });
                unsafe { core::slice::from_raw_parts(item.value.cast::<u8>(), length) }.to_vec()
            });
            Some((key, value))
        })
        .collect()
}

unsafe fn ipv4_addresses(mut address: *const sys::mdns_ip_addr_t) -> Vec<Ipv4Addr> {
    let mut addresses = Vec::new();
    while let Some(current) = unsafe { address.as_ref() } {
        if u32::from(current.addr.type_) == sys::ESP_IPADDR_TYPE_V4 {
            // esp_ip4_addr stores network order, least-significant byte first here.
            let ip4 = unsafe { current.addr.u_addr.ip4 };
            addresses.push(Ipv4Addr::from(ip4.addr.to_le_bytes()));
        }
        address = current.next;
    }
    addresses
}
