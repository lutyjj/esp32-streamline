//! Validated provisioning settings. Audio bounds come from the resolved
//! board descriptor (`crate::board`), so validation stays host-testable
//! and cannot diverge from what the device advertises.

use std::{collections::BTreeMap, time::Duration};

use serde::{Deserialize, Serialize};

use crate::{
    board::{Board, Led},
    led::LedRole,
    transport::{TransportError, TransportSettings},
};

pub const MIN_PORT: u16 = 1;
/// Longest friendly device name, in characters. Fits an NVS string entry and
/// a browser tab title.
pub const MAX_DEVICE_NAME_CHARS: usize = 32;
/// Admin keys are generated, never composed by hand: exactly 24 random bytes
/// rendered as lowercase hexadecimal. One exact shape keeps runtime
/// validation, the OpenAPI schema, and every client in agreement.
pub const ADMIN_SECRET_HEX_CHARS: usize = 48;
/// The canonical admin-key shape as the OpenAPI schema declares it.
pub const ADMIN_SECRET_PATTERN: &str = "^[0-9a-f]{48}$";
/// A valid admin key for tests across modules, in the canonical form.
#[cfg(test)]
pub(crate) const TEST_ADMIN_SECRET: &str = "0123456789abcdef0123456789abcdef0123456789abcdef";

/// Whether an admin secret is in the canonical generated form.
pub fn is_canonical_admin_secret(secret: &str) -> bool {
    secret.len() == ADMIN_SECRET_HEX_CHARS
        && secret
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
/// Version stamped into persisted configuration. An incompatible stored version is
/// treated as unconfigured so the device re-commissions rather than booting without
/// an admin key.
pub const CONFIG_SCHEMA_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[repr(u8)]
pub enum AutoUpdateSchedule {
    Disabled = 0,
    Daily = 1,
    Weekly = 2,
}

impl AutoUpdateSchedule {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "disabled" => Some(Self::Disabled),
            "daily" => Some(Self::Daily),
            "weekly" => Some(Self::Weekly),
            _ => None,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
        }
    }

    /// Decode the optional NVS value. Absence means the default for devices
    /// provisioned before this setting existed; unknown future values fail
    /// closed if older firmware boots the same NVS.
    pub const fn from_storage(value: Option<u8>) -> Self {
        match value {
            None | Some(1) => Self::Daily,
            Some(2) => Self::Weekly,
            Some(0) | Some(_) => Self::Disabled,
        }
    }

    pub const fn interval(self) -> Option<Duration> {
        match self {
            Self::Disabled => None,
            Self::Daily => Some(Duration::from_secs(24 * 60 * 60)),
            Self::Weekly => Some(Duration::from_secs(7 * 24 * 60 * 60)),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioSettings {
    /// Selected input, one of the resolved board's advertised lines.
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
}

impl AudioSettings {
    pub fn validate(self, board: &Board) -> Result<Self, ConfigError> {
        if !board.accepts_line(self.input_line) {
            return Err(ConfigError::InvalidInputLine);
        }
        if self.input_gain > board.input_gain_max {
            return Err(ConfigError::InvalidInputGain);
        }
        if self.adc_attenuation_db > board.adc_atten_max_db {
            return Err(ConfigError::InvalidAdcAttenuation);
        }
        Ok(self)
    }

    pub fn compatible_with(self, board: &Board) -> Self {
        Self {
            input_line: if board.accepts_line(self.input_line) {
                self.input_line
            } else {
                board.default_line()
            },
            input_gain: self.input_gain.min(board.input_gain_max),
            adc_attenuation_db: self.adc_attenuation_db.min(board.adc_atten_max_db),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NetworkSettings<'a> {
    pub ssid: &'a str,
    pub target_host: &'a str,
    pub target_port: u16,
}

impl<'a> NetworkSettings<'a> {
    pub fn validate(self) -> Result<Self, ConfigError> {
        if self.ssid.is_empty() {
            return Err(ConfigError::MissingSsid);
        }
        if self.target_host.contains(':') || self.target_host.contains('/') {
            return Err(ConfigError::MalformedTargetHost);
        }
        if self.target_port < MIN_PORT {
            return Err(ConfigError::InvalidTargetPort);
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigError {
    MissingSsid,
    MalformedTargetHost,
    InvalidTargetPort,
    InvalidInputLine,
    InvalidInputGain,
    InvalidAdcAttenuation,
    UnsupportedAnalogPassthrough,
    UnknownLed,
    MalformedAdminSecret,
    DeviceNameTooLong,
    InvalidTransport(TransportError),
}

/// The application-owned configuration loaded from persistent storage.
///
/// The configuration is intentionally independent of ESP-IDF types. Hardware
/// adapters translate it only at their boundary, so validation can be tested
/// on the host and used by both the setup HTTP service and boot path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RuntimeConfig {
    pub ssid: String,
    pub password: String,
    /// Bridge host the PCM stream is sent to. Empty means no bridge is
    /// configured yet: the device joins Wi-Fi and serves the console but does
    /// not stream.
    pub target_host: String,
    pub target_port: u16,
    /// Versioned PCM transport policy and write-only per-device keys. Missing
    /// on installations created before secure transport and therefore
    /// defaults to cleartext without invalidating their configuration.
    #[serde(default)]
    pub transport: TransportSettings,
    /// Admin key required on the mutating HTTP API. Set during commissioning
    /// and write-only: it is persisted but never returned through the API.
    pub admin_secret: String,
    /// Friendly name that tells devices apart in the console and browser tab.
    /// Empty means unnamed; clients fall back to the device's address.
    pub device_name: String,
    /// How often to install newer published releases while provisioned.
    pub auto_update_schedule: AutoUpdateSchedule,
    pub audio: AudioSettings,
    /// Whether the selected board's local analog output should be active.
    #[serde(default)]
    pub analog_passthrough_enabled: bool,
    /// Per-LED role assignments keyed by board LED id. A LED absent here uses
    /// its descriptor default role. Missing on installations provisioned before
    /// LED control existed, so it defaults to empty.
    #[serde(default)]
    pub led_roles: BTreeMap<String, LedRole>,
}

impl RuntimeConfig {
    pub fn validate(&self, board: &Board) -> Result<(), ConfigError> {
        NetworkSettings {
            ssid: &self.ssid,
            target_host: &self.target_host,
            target_port: self.target_port,
        }
        .validate()?;
        if !is_canonical_admin_secret(&self.admin_secret) {
            return Err(ConfigError::MalformedAdminSecret);
        }
        if self.device_name.chars().count() > MAX_DEVICE_NAME_CHARS {
            return Err(ConfigError::DeviceNameTooLong);
        }
        self.transport
            .validate()
            .map_err(ConfigError::InvalidTransport)?;
        self.audio.validate(board)?;
        if self.analog_passthrough_enabled && board.analog_passthrough.is_none() {
            return Err(ConfigError::UnsupportedAnalogPassthrough);
        }
        if self.led_roles.keys().any(|id| !board.has_led(id)) {
            return Err(ConfigError::UnknownLed);
        }
        Ok(())
    }

    pub fn with_board_compatible_with(mut self, board: &Board) -> Self {
        self.audio = self.audio.compatible_with(board);
        if board.analog_passthrough.is_none() {
            self.analog_passthrough_enabled = false;
        }
        self.led_roles.retain(|id, _| board.has_led(id));
        self
    }

    /// The role a board LED renders: the user's assignment if set, otherwise the
    /// descriptor default.
    pub fn led_role(&self, led: &Led) -> LedRole {
        self.led_roles
            .get(&led.id)
            .copied()
            .unwrap_or(led.default_role)
    }

    /// Whether any board LED currently renders the device status, so status has
    /// a visible indicator.
    pub fn shows_status_indicator(&self, board: &Board) -> bool {
        board
            .leds
            .iter()
            .any(|led| self.led_role(led) == LedRole::Status)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::{AudioSettings, AutoUpdateSchedule, ConfigError, NetworkSettings};
    use crate::board::{self, Board, CodecSpec, I2cPins, I2sPins, InputOption, Led, PinMap};
    use crate::led::LedRole;

    #[test]
    fn accepts_the_deployed_network_shape() {
        let settings = NetworkSettings {
            ssid: "studio",
            target_host: "192.0.2.10",
            target_port: 39_000,
        };

        assert_eq!(settings.validate(), Ok(settings));
    }

    #[test]
    fn accepts_an_unset_target_host() {
        let settings = NetworkSettings {
            ssid: "studio",
            target_host: "",
            target_port: 39_000,
        };

        assert_eq!(settings.validate(), Ok(settings));
    }

    #[test]
    fn rejects_target_urls_and_ports() {
        for target_host in ["tcp://192.0.2.10", "192.0.2.10:39000"] {
            let settings = NetworkSettings {
                ssid: "studio",
                target_host,
                target_port: 39_000,
            };
            assert!(settings.validate().is_err());
        }

        let invalid_port = NetworkSettings {
            ssid: "studio",
            target_host: "192.0.2.10",
            target_port: 0,
        };
        assert_eq!(invalid_port.validate(), Err(ConfigError::InvalidTargetPort));
    }

    #[test]
    fn validates_audio_against_the_board() {
        let board = default_board();
        assert_eq!(
            AudioSettings {
                input_line: 3,
                input_gain: 0,
                adc_attenuation_db: 0,
            }
            .validate(&board),
            Err(ConfigError::InvalidInputLine)
        );
        assert_eq!(
            AudioSettings {
                input_line: 2,
                input_gain: board.input_gain_max + 1,
                adc_attenuation_db: 0,
            }
            .validate(&board),
            Err(ConfigError::InvalidInputGain)
        );
        assert_eq!(
            AudioSettings {
                input_line: 2,
                input_gain: 0,
                adc_attenuation_db: board.adc_atten_max_db + 1,
            }
            .validate(&board),
            Err(ConfigError::InvalidAdcAttenuation)
        );
    }

    #[test]
    fn adapts_audio_to_a_board_contract() {
        let board = Board {
            id: "test-board".to_owned(),
            name: "test board".to_owned(),
            codec: CodecSpec {
                driver: "es8388".to_owned(),
                i2c_address: 0x10,
            },
            pins: PinMap {
                i2c: I2cPins { sda: 4, scl: 5 },
                i2s: I2sPins {
                    mclk: 12,
                    bclk: 13,
                    ws: 14,
                    din: 35,
                },
            },
            leds: Vec::new(),
            analog_passthrough: None,
            input_lines: vec![InputOption {
                line: 7,
                label: "test input".to_owned(),
            }],
            input_gain_max: 20,
            adc_atten_max_db: 6,
        };

        assert_eq!(
            AudioSettings {
                input_line: 2,
                input_gain: 80,
                adc_attenuation_db: 48,
            }
            .compatible_with(&board),
            AudioSettings {
                input_line: 7,
                input_gain: 20,
                adc_attenuation_db: 6,
            }
        );
    }

    fn sample_runtime_config() -> super::RuntimeConfig {
        super::RuntimeConfig {
            ssid: "studio".to_owned(),
            password: "secret".to_owned(),
            target_host: "bridge.local".to_owned(),
            target_port: 39_000,
            transport: Default::default(),
            admin_secret: super::TEST_ADMIN_SECRET.to_owned(),
            device_name: String::new(),
            auto_update_schedule: AutoUpdateSchedule::Daily,
            audio: AudioSettings {
                input_line: 2,
                input_gain: 0,
                adc_attenuation_db: 0,
            },
            analog_passthrough_enabled: false,
            led_roles: BTreeMap::new(),
        }
    }

    #[test]
    fn validates_an_owned_runtime_configuration() {
        assert_eq!(sample_runtime_config().validate(&default_board()), Ok(()));
    }

    #[test]
    fn persisted_configuration_without_local_output_intent_defaults_off() {
        let mut value = serde_json::to_value(sample_runtime_config()).expect("serializable config");
        value
            .as_object_mut()
            .expect("config object")
            .remove("analog_passthrough_enabled");

        let decoded: super::RuntimeConfig =
            serde_json::from_value(value).expect("compatible persisted config");

        assert!(!decoded.analog_passthrough_enabled);
    }

    #[test]
    fn board_compatibility_disables_an_unsupported_local_output() {
        let mut config = sample_runtime_config();
        config.analog_passthrough_enabled = true;
        let mut board = default_board();
        board.analog_passthrough = None;

        assert_eq!(
            config.validate(&board),
            Err(ConfigError::UnsupportedAnalogPassthrough)
        );
        assert!(
            !config
                .with_board_compatible_with(&board)
                .analog_passthrough_enabled
        );
    }

    #[test]
    fn bounds_the_device_name_by_characters_not_bytes() {
        let mut config = sample_runtime_config();
        config.device_name = "ü".repeat(super::MAX_DEVICE_NAME_CHARS);
        assert_eq!(config.validate(&default_board()), Ok(()));

        config.device_name.push('x');
        assert_eq!(
            config.validate(&default_board()),
            Err(ConfigError::DeviceNameTooLong)
        );
    }

    #[test]
    fn accepts_only_the_canonical_admin_secret_shape() {
        let mut config = sample_runtime_config();
        assert_eq!(config.validate(&default_board()), Ok(()));

        for invalid in [
            String::new(),
            "short".to_owned(),
            super::TEST_ADMIN_SECRET.to_uppercase(),
            super::TEST_ADMIN_SECRET[..47].to_owned(),
            format!("{}0", super::TEST_ADMIN_SECRET),
            format!("{}g", &super::TEST_ADMIN_SECRET[..47]),
            format!("{}é", &super::TEST_ADMIN_SECRET[..47]),
        ] {
            config.admin_secret = invalid.clone();
            assert_eq!(
                config.validate(&default_board()),
                Err(ConfigError::MalformedAdminSecret),
                "must reject {invalid:?}",
            );
        }
    }

    #[test]
    fn automatic_update_schedules_have_stable_api_and_storage_names() {
        for (name, stored, schedule) in [
            ("disabled", 0, AutoUpdateSchedule::Disabled),
            ("daily", 1, AutoUpdateSchedule::Daily),
            ("weekly", 2, AutoUpdateSchedule::Weekly),
        ] {
            assert_eq!(AutoUpdateSchedule::parse(name), Some(schedule));
            assert_eq!(schedule.as_str(), name);
            assert_eq!(AutoUpdateSchedule::from_storage(Some(stored)), schedule);
            assert_eq!(schedule as u8, stored);
        }
        assert_eq!(
            AutoUpdateSchedule::from_storage(None),
            AutoUpdateSchedule::Daily
        );
        assert_eq!(AutoUpdateSchedule::parse("0 3 * * *"), None);
        assert_eq!(
            AutoUpdateSchedule::from_storage(Some(3)),
            AutoUpdateSchedule::Disabled
        );
    }

    #[test]
    fn rejects_a_role_for_an_led_the_board_does_not_have() {
        let mut config = sample_runtime_config();
        config
            .led_roles
            .insert("nonexistent".to_owned(), LedRole::On);
        assert_eq!(
            config.validate(&default_board()),
            Err(ConfigError::UnknownLed)
        );
    }

    #[test]
    fn board_compatibility_drops_roles_for_absent_leds() {
        let mut config = sample_runtime_config();
        config.led_roles.insert("status".to_owned(), LedRole::On);
        config.led_roles.insert("ghost".to_owned(), LedRole::On);

        let compatible = config.with_board_compatible_with(&default_board());

        assert_eq!(compatible.led_roles.get("status"), Some(&LedRole::On));
        assert!(!compatible.led_roles.contains_key("ghost"));
    }

    #[test]
    fn effective_role_prefers_the_assignment_then_the_descriptor_default() {
        let led = Led {
            id: "status".to_owned(),
            label: "Status light".to_owned(),
            gpio: 22,
            active_low: false,
            default_role: LedRole::Status,
        };
        let mut config = sample_runtime_config();
        assert_eq!(config.led_role(&led), LedRole::Status);
        config.led_roles.insert("status".to_owned(), LedRole::Off);
        assert_eq!(config.led_role(&led), LedRole::Off);
    }

    #[test]
    fn status_indicator_visible_only_while_a_led_renders_it() {
        let board = default_board();
        let mut config = sample_runtime_config();
        assert!(config.shows_status_indicator(&board));
        config.led_roles.insert("status".to_owned(), LedRole::Off);
        assert!(!config.shows_status_indicator(&board));
    }

    #[test]
    fn persisted_configuration_without_led_roles_defaults_empty() {
        let mut value = serde_json::to_value(sample_runtime_config()).expect("serializable config");
        value
            .as_object_mut()
            .expect("config object")
            .remove("led_roles");

        let decoded: super::RuntimeConfig =
            serde_json::from_value(value).expect("compatible persisted config");

        assert!(decoded.led_roles.is_empty());
    }

    fn default_board() -> Board {
        let catalog = board::builtin_catalog().expect("valid catalog");
        board::resolve(&catalog, None)
            .expect("default board")
            .clone()
    }
}
