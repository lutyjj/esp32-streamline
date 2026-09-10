//! Device labels for setup and local discovery.

use unicode_normalization::UnicodeNormalization;

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

/// Derive the DNS-SD instance label without restricting the display name.
/// RFC 6763 section 4.1.1 requires NFC text in a label of at most 63 bytes.
/// Strip control characters, keep a whole-character prefix, and use the
/// product name when no visible name remains.
pub fn mdns_instance_name(display_name: &str) -> String {
    let mut instance = String::new();
    for character in display_name.chars().filter(|c| !c.is_control()).nfc() {
        if instance.len() + character.len_utf8() > 63 {
            break;
        }
        instance.push(character);
    }
    let instance = instance.trim();
    if instance.is_empty() {
        "StreamLine".to_owned()
    } else {
        instance.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{local_hostname, mdns_hostname, mdns_instance_name, setup_suffix};

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

    #[test]
    fn discovery_names_keep_whole_utf8_characters_within_the_label_limit() {
        for (display, expected) in [
            ("ü".repeat(32), "ü".repeat(31)),
            ("🎵".repeat(32), "🎵".repeat(15)),
            (
                format!("{}a", "ü".repeat(31)),
                format!("{}a", "ü".repeat(31)),
            ),
            ("Studio".to_owned(), "Studio".to_owned()),
        ] {
            assert_eq!(mdns_instance_name(&display), expected);
        }
    }

    #[test]
    fn discovery_names_normalize_unicode_and_remove_control_characters() {
        assert_eq!(mdns_instance_name("  Cafe\u{301}\0\n  "), "Café");
        for name in ["", "   ", "\0\n\u{85}"] {
            assert_eq!(mdns_instance_name(name), "StreamLine");
        }
    }
}
