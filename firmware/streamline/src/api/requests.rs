//! Request DTOs the device deserializes at its write endpoints.
//!
//! Form-encoded or JSON bodies validated at the boundary. The route table that
//! references them and the response types live beside this module in `super`.
//!
//! JSON Schema counts characters, and the device counts some lengths in UTF-8
//! bytes. There the schema states the character bound the byte rule implies
//! and a pattern exact for ASCII, so no keyword refuses a value the device
//! accepts, and the device's refusal names the field for the rest.

use serde::{Deserialize, Serialize};

/// A bridge host: a name or address without a scheme, port, path or spaces.
pub const TARGET_HOST_PATTERN: &str = r"^[^:/\s]*$";
/// A Wi-Fi network name without NUL; its length rides `maxLength`.
pub const WIFI_SSID_PATTERN: &str = r"^[^\u0000]*$";
/// A WPA2 password: empty, 8 to 63 ASCII characters other than NUL, 64
/// hexadecimal digits, or any value with a character beyond ASCII, which the
/// device measures in bytes.
pub const WIFI_PASSWORD_PATTERN: &str =
    r"^(?:[\u0001-\u007F]{8,63}|[0-9A-Fa-f]{64}|[^\u0000]*[^\u0000-\u007F][^\u0000]*)?$";

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct WifiSettingsRequest {
    /// Wi-Fi network name: 1 to 32 UTF-8 bytes, without NUL.
    #[cfg_attr(
        feature = "api-spec",
        schema(min_length = 1, max_length = 32, pattern = r"^[^\u0000]*$")
    )]
    pub ssid: String,
    /// WPA2 password: 8 to 63 bytes or a 64-digit hexadecimal PSK, without NUL.
    /// Empty keeps the stored password, so a protected network that has none
    /// stored needs one. Must be empty when `open_network` is true.
    #[serde(default)]
    #[cfg_attr(
        feature = "api-spec",
        schema(
            max_length = 64,
            pattern = r"^(?:[\u0001-\u007F]{8,63}|[0-9A-Fa-f]{64}|[^\u0000]*[^\u0000-\u007F][^\u0000]*)?$"
        )
    )]
    pub password: String,
    /// Join `ssid` as an open network, without a password. The device then
    /// joins only an open network by that name.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(default = false))]
    pub open_network: bool,
    /// Optional bridge host set during first commissioning.
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[^:/\s]*$"))]
    pub target_host: Option<String>,
    #[cfg_attr(feature = "api-spec", schema(minimum = 1, maximum = 65535))]
    pub target_port: Option<u16>,
    /// Generated 48-character lowercase-hex admin key. Empty preserves the
    /// stored key.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(pattern = "^$|^[0-9a-f]{48}$"))]
    pub admin_key: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct TargetSettingsRequest {
    /// Hostname or IP without a scheme, port, path, or spaces. Empty clears
    /// the target.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[^:/\s]*$"))]
    pub target_host: String,
    #[cfg_attr(feature = "api-spec", schema(minimum = 1, maximum = 65535))]
    pub target_port: Option<u16>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct TransportSettingsRequest {
    pub contract_version: u8,
    pub mode: crate::transport::TransportMode,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Select exactly one built-in id or a JSON-encoded custom descriptor.
pub struct BoardSettingsRequest {
    pub board_id: Option<String>,
    /// JSON-encoded descriptor, capped at 3072 UTF-8 bytes by the device.
    #[cfg_attr(feature = "api-spec", schema(max_length = 3072))]
    pub descriptor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Audio values are validated against `/api/status.capabilities`.
pub struct AudioSettingsRequest {
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AnalogPassthroughSettingsRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Assign one board LED, named by its capabilities id, a new role.
pub struct LedSettingsRequest {
    pub id: String,
    pub role: crate::led::LedRole,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Assign one board button, named by its capabilities id, a new action.
pub struct ButtonSettingsRequest {
    pub id: String,
    pub action: crate::button::ButtonAction,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Runtime streaming control; the choice is not persisted and a reboot
/// resumes streaming.
pub struct StreamRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioProfilesSettingsRequest {
    /// JSON-encoded `AudioProfileCatalog`.
    pub catalog: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct ActiveAudioProfileRequest {
    /// Empty returns to custom audio settings.
    #[serde(default)]
    pub profile_id: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct NameSettingsRequest {
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(max_length = 32))]
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AdminKeySettingsRequest {
    /// Generated 48-character lowercase-hex admin key.
    #[cfg_attr(
        feature = "api-spec",
        schema(min_length = 48, max_length = 48, pattern = "^[0-9a-f]{48}$")
    )]
    pub admin_key: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct FirmwareSettingsRequest {
    pub auto_update_schedule: AutoUpdateScheduleRequest,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum AutoUpdateScheduleRequest {
    Disabled,
    Daily,
    Weekly,
}

impl From<crate::config::AutoUpdateSchedule> for AutoUpdateScheduleRequest {
    fn from(value: crate::config::AutoUpdateSchedule) -> Self {
        match value {
            crate::config::AutoUpdateSchedule::Disabled => Self::Disabled,
            crate::config::AutoUpdateSchedule::Daily => Self::Daily,
            crate::config::AutoUpdateSchedule::Weekly => Self::Weekly,
        }
    }
}

#[derive(Default, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
/// Empty installs the latest release. A custom install requires both fields.
pub struct OtaUpdateRequest {
    /// HTTP(S) download URL. Query parameters are preserved; userinfo and
    /// fragments are rejected.
    #[cfg_attr(
        feature = "api-spec",
        schema(pattern = r"^https?://[^/?#@\s]+(?:[/?][^#\s]*)?$")
    )]
    pub url: Option<String>,
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[0-9A-Fa-f]{64}$"))]
    pub sha256: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_dtos_reject_fields_outside_the_contract() {
        let result = serde_urlencoded::from_str::<AudioSettingsRequest>(
            "input_line=2&input_gain=0&adc_attenuation_db=0&unexpected=true",
        );
        assert!(result.is_err());
    }

    /// The contract's Wi-Fi and host patterns admit every value the device
    /// accepts, and agree with it on every ASCII value.
    #[test]
    fn contract_patterns_never_refuse_what_the_device_accepts() {
        use crate::config::{is_valid_wifi_password, NetworkSettings, MAX_SSID_BYTES};

        let pattern = |source| regex::Regex::new(source).expect("valid pattern");
        let password = pattern(WIFI_PASSWORD_PATTERN);
        let long = "x".repeat(63);
        let too_long = "x".repeat(64);
        let hex = "aB3".repeat(21) + "f";
        let wide = "é".repeat(31);
        let too_wide = "é".repeat(32);
        for candidate in [
            "seven77",
            "eight888",
            &long,
            &too_long,
            &hex,
            "pässwö",
            &wide,
            &too_wide,
            "nul\0inside",
        ] {
            let accepted = is_valid_wifi_password(candidate);
            let matched = password.is_match(candidate);
            if candidate.is_ascii() {
                assert_eq!(matched, accepted, "{candidate:?}");
            } else {
                assert!(matched || !accepted, "{candidate:?}");
            }
        }
        assert!(
            password.is_match(""),
            "an empty password keeps the stored one"
        );

        let ssid = pattern(WIFI_SSID_PATTERN);
        let target = pattern(TARGET_HOST_PATTERN);
        for candidate in ["home", "café 5G", &"s".repeat(MAX_SSID_BYTES), "a\0b"] {
            let settings = NetworkSettings {
                ssid: candidate,
                target_host: "",
                target_port: 1,
            };
            let fits = ssid.is_match(candidate) && candidate.chars().count() <= MAX_SSID_BYTES;
            assert!(fits || settings.validate().is_err(), "{candidate:?}");
        }
        for host in [
            "bridge.local",
            "192.0.2.20",
            "",
            "my bridge",
            "host:39000",
            "http://x",
        ] {
            let settings = NetworkSettings {
                ssid: "home",
                target_host: host,
                target_port: 1,
            };
            assert_eq!(
                target.is_match(host),
                settings.validate().is_ok(),
                "{host:?}"
            );
        }
    }

    #[test]
    fn request_dtos_decode_browser_urlencoded_forms() {
        let form: WifiSettingsRequest =
            serde_urlencoded::from_str("ssid=Studio+WiFi&target_host=bridge%2Elocal")
                .expect("valid form");
        assert_eq!(form.ssid, "Studio WiFi");
        assert_eq!(form.target_host.as_deref(), Some("bridge.local"));
        assert!(!form.open_network);
        let form: WifiSettingsRequest =
            serde_urlencoded::from_str("ssid=Cafe&open_network=true").expect("valid form");
        assert!(form.open_network);
    }
}
