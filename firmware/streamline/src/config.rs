//! Validated, hardware-independent provisioning settings.

pub const MIN_PORT: u16 = 1;
pub const MAX_ADC_ATTENUATION_DB: u8 = 48;
/// Longest friendly device name, in characters. Fits an NVS string entry and
/// a browser tab title.
pub const MAX_DEVICE_NAME_CHARS: usize = 32;
/// Minimum length for the admin key that guards the mutating HTTP API.
pub const MIN_ADMIN_SECRET_LEN: usize = 8;
/// Version stamped into persisted configuration. An incompatible stored version is
/// treated as unconfigured so the device re-commissions rather than booting without
/// an admin key.
pub const CONFIG_SCHEMA_VERSION: u8 = 2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputLine {
    One,
    Two,
}

impl TryFrom<u8> for InputLine {
    type Error = ConfigError;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::One),
            2 => Ok(Self::Two),
            _ => Err(ConfigError::InvalidInputLine),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AudioSettings {
    pub input_line: InputLine,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
}

impl AudioSettings {
    pub const fn validate(self) -> Result<Self, ConfigError> {
        if self.input_gain > 100 {
            return Err(ConfigError::InvalidInputGain);
        }
        if self.adc_attenuation_db > MAX_ADC_ATTENUATION_DB {
            return Err(ConfigError::InvalidAdcAttenuation);
        }
        Ok(self)
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
    WeakAdminSecret,
    DeviceNameTooLong,
}

/// The application-owned configuration loaded from persistent storage.
///
/// The configuration is intentionally independent of ESP-IDF types. Hardware
/// adapters translate it only at their boundary, so validation can be tested
/// on the host and used by both the setup HTTP service and boot path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeConfig {
    pub ssid: String,
    pub password: String,
    /// Bridge host the PCM stream is sent to. Empty means no bridge is
    /// configured yet: the device joins Wi-Fi and serves the console but does
    /// not stream.
    pub target_host: String,
    pub target_port: u16,
    /// Admin key required on the mutating HTTP API. Set during commissioning
    /// and write-only: it is persisted but never returned through the API.
    pub admin_secret: String,
    /// Friendly name that tells devices apart in the console and browser tab.
    /// Empty means unnamed; clients fall back to the device's address.
    pub device_name: String,
    pub audio: AudioSettings,
}

impl RuntimeConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        NetworkSettings {
            ssid: &self.ssid,
            target_host: &self.target_host,
            target_port: self.target_port,
        }
        .validate()?;
        if self.admin_secret.len() < MIN_ADMIN_SECRET_LEN {
            return Err(ConfigError::WeakAdminSecret);
        }
        if self.device_name.chars().count() > MAX_DEVICE_NAME_CHARS {
            return Err(ConfigError::DeviceNameTooLong);
        }
        self.audio.validate()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioSettings, ConfigError, InputLine, NetworkSettings};

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
    fn validates_audio_bounds() {
        assert_eq!(InputLine::try_from(3), Err(ConfigError::InvalidInputLine));
        assert_eq!(
            AudioSettings {
                input_line: InputLine::Two,
                input_gain: 101,
                adc_attenuation_db: 0,
            }
            .validate(),
            Err(ConfigError::InvalidInputGain)
        );
    }

    fn sample_runtime_config() -> super::RuntimeConfig {
        super::RuntimeConfig {
            ssid: "studio".to_owned(),
            password: "secret".to_owned(),
            target_host: "bridge.local".to_owned(),
            target_port: 39_000,
            admin_secret: "console-secret".to_owned(),
            device_name: String::new(),
            audio: AudioSettings {
                input_line: InputLine::Two,
                input_gain: 0,
                adc_attenuation_db: 0,
            },
        }
    }

    #[test]
    fn validates_an_owned_runtime_configuration() {
        assert_eq!(sample_runtime_config().validate(), Ok(()));
    }

    #[test]
    fn bounds_the_device_name_by_characters_not_bytes() {
        let mut config = sample_runtime_config();
        config.device_name = "ü".repeat(super::MAX_DEVICE_NAME_CHARS);
        assert_eq!(config.validate(), Ok(()));

        config.device_name.push('x');
        assert_eq!(config.validate(), Err(ConfigError::DeviceNameTooLong));
    }

    #[test]
    fn rejects_a_short_admin_secret() {
        let mut config = sample_runtime_config();
        config.admin_secret = "short".to_owned();
        assert_eq!(config.validate(), Err(ConfigError::WeakAdminSecret));

        config.admin_secret = String::new();
        assert_eq!(config.validate(), Err(ConfigError::WeakAdminSecret));
    }
}
