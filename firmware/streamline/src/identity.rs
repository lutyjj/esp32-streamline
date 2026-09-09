//! Device names derived from immutable board identity.

/// Suffix used in the setup access point SSID.
pub fn setup_suffix(mac: [u8; 6]) -> String {
    format!("{:02X}{:02X}{:02X}", mac[3], mac[4], mac[5])
}

/// The setup access point's SSID for a device suffix.
pub fn setup_ssid(suffix: &str) -> String {
    format!("esp32-streamline-{suffix}")
}

/// Bare mDNS host label. The resolver presents it as `<label>.local`.
pub fn mdns_hostname(mac: [u8; 6]) -> String {
    format!("streamline-{:02x}{:02x}", mac[4], mac[5])
}

pub fn local_hostname(hostname: &str) -> String {
    format!("{hostname}.local")
}

#[cfg(test)]
mod tests {
    use super::{local_hostname, mdns_hostname, setup_suffix};

    #[test]
    fn setup_suffix_uses_last_three_mac_octets() {
        assert_eq!(setup_suffix([0xb0, 0xcb, 0xd8, 0x1a, 0xa8, 0xb2]), "1AA8B2");
    }

    #[test]
    fn mdns_hostname_uses_last_two_mac_octets() {
        assert_eq!(
            mdns_hostname([0xb0, 0xcb, 0xd8, 0x1a, 0xa8, 0xb2]),
            "streamline-a8b2"
        );
        assert_eq!(local_hostname("streamline-a8b2"), "streamline-a8b2.local");
    }
}
