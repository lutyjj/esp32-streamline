//! Validated provisioning settings. Audio bounds come from the resolved
//! board descriptor (`crate::board`), so validation stays host-testable
//! and cannot diverge from what the device advertises.

use crate::board::Board;

pub const MIN_PORT: u16 = 1;
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
pub struct AudioSettings {
    /// Selected input, one of the resolved board's advertised lines.
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_attenuation_db: u8,
}

impl AudioSettings {
    pub fn validate(self, board: &Board<'_>) -> Result<Self, ConfigError> {
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

    pub fn compatible_with(self, board: &Board<'_>) -> Self {
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
    pub fn validate(&self, board: &Board<'_>) -> Result<(), ConfigError> {
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
        self.audio.validate(board)?;
        Ok(())
    }

    pub fn with_audio_compatible_with(mut self, board: &Board<'_>) -> Self {
        self.audio = self.audio.compatible_with(board);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioSettings, ConfigError, NetworkSettings};
    use crate::board::{
        self, Board, CodecDriverId, CodecSpec, I2cPins, I2sPins, InputOption, PinMap,
    };

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
        let board = board::DEFAULT_PRESET;
        assert_eq!(
            AudioSettings {
                input_line: 3,
                input_gain: 0,
                adc_attenuation_db: 0,
            }
            .validate(board),
            Err(ConfigError::InvalidInputLine)
        );
        assert_eq!(
            AudioSettings {
                input_line: 2,
                input_gain: board.input_gain_max + 1,
                adc_attenuation_db: 0,
            }
            .validate(board),
            Err(ConfigError::InvalidInputGain)
        );
        assert_eq!(
            AudioSettings {
                input_line: 2,
                input_gain: 0,
                adc_attenuation_db: board.adc_atten_max_db + 1,
            }
            .validate(board),
            Err(ConfigError::InvalidAdcAttenuation)
        );
    }

    #[test]
    fn adapts_audio_to_a_board_contract() {
        let board = Board {
            id: "test-board",
            name: "test board",
            codec: CodecSpec {
                driver: CodecDriverId::ES8388,
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
            input_lines: &[InputOption {
                line: 7,
                label: "test input",
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
            admin_secret: "console-secret".to_owned(),
            device_name: String::new(),
            audio: AudioSettings {
                input_line: 2,
                input_gain: 0,
                adc_attenuation_db: 0,
            },
        }
    }

    #[test]
    fn validates_an_owned_runtime_configuration() {
        assert_eq!(
            sample_runtime_config().validate(board::DEFAULT_PRESET),
            Ok(())
        );
    }

    #[test]
    fn bounds_the_device_name_by_characters_not_bytes() {
        let mut config = sample_runtime_config();
        config.device_name = "ü".repeat(super::MAX_DEVICE_NAME_CHARS);
        assert_eq!(config.validate(board::DEFAULT_PRESET), Ok(()));

        config.device_name.push('x');
        assert_eq!(
            config.validate(board::DEFAULT_PRESET),
            Err(ConfigError::DeviceNameTooLong)
        );
    }

    #[test]
    fn rejects_a_short_admin_secret() {
        let mut config = sample_runtime_config();
        config.admin_secret = "short".to_owned();
        assert_eq!(
            config.validate(board::DEFAULT_PRESET),
            Err(ConfigError::WeakAdminSecret)
        );

        config.admin_secret = String::new();
        assert_eq!(
            config.validate(board::DEFAULT_PRESET),
            Err(ConfigError::WeakAdminSecret)
        );
    }
}
