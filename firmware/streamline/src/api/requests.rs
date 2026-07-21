//! Request DTOs the device deserializes at its write endpoints.
//!
//! Form-encoded or JSON bodies validated at the boundary. The route table that
//! references them and the response types live beside this module in `super`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct WifiSettingsRequest {
    /// Wi-Fi network name. Empty names are rejected.
    #[cfg_attr(feature = "api-spec", schema(min_length = 1))]
    pub ssid: String,
    /// Wi-Fi password. Empty preserves the stored password.
    #[serde(default)]
    pub password: String,
    /// Optional bridge host set during first commissioning.
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[^:/]*$"))]
    pub target_host: Option<String>,
    #[cfg_attr(feature = "api-spec", schema(minimum = 1))]
    pub target_port: Option<u16>,
    /// Generated 48-character lowercase-hex admin key. Empty preserves the
    /// stored key.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(pattern = "^$|^[0-9a-f]{48}$"))]
    pub admin_secret: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct TargetSettingsRequest {
    /// Hostname or IP without a scheme, port, or path. Empty clears the target.
    #[serde(default)]
    #[cfg_attr(feature = "api-spec", schema(pattern = r"^[^:/]*$"))]
    pub target_host: String,
    #[cfg_attr(feature = "api-spec", schema(minimum = 1))]
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
    pub admin_secret: String,
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

    #[test]
    fn request_dtos_decode_browser_urlencoded_forms() {
        let form: WifiSettingsRequest =
            serde_urlencoded::from_str("ssid=Studio+WiFi&target_host=bridge%2Elocal")
                .expect("valid form");
        assert_eq!(form.ssid, "Studio WiFi");
        assert_eq!(form.target_host.as_deref(), Some("bridge.local"));
    }
}
