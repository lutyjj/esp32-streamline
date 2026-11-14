//! Setup-mode configuration baselines and Wi-Fi recovery edits.

use crate::{
    board::Board,
    config::{AudioSettings, AutoUpdateSchedule, ConfigError, RuntimeConfig},
    transport::DEFAULT_PORT,
};

/// The setup AP starts either with no durable configuration or with the last
/// validated configuration after station association failed.
pub fn setup_baseline(board: &Board, persisted: Option<RuntimeConfig>) -> RuntimeConfig {
    persisted.unwrap_or_else(|| RuntimeConfig {
        ssid: String::new(),
        password: String::new(),
        target_host: String::new(),
        target_port: DEFAULT_PORT,
        transport: Default::default(),
        admin_key: String::new(),
        device_name: String::new(),
        auto_update_schedule: AutoUpdateSchedule::Daily,
        audio: AudioSettings {
            input_line: board.default_line(),
            input_gain: 0,
            adc_attenuation_db: 0,
        },
        analog_passthrough_enabled: false,
        led_roles: Default::default(),
        button_actions: Default::default(),
    })
}

/// What a Wi-Fi write asks for the network's password.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WifiPassword {
    /// A protected network keeps the stored password.
    Keep,
    /// A protected network with this password.
    Replace(String),
    /// An open network, joined without a password.
    Open,
}

impl WifiPassword {
    /// Read a form's password and open-network choice. A blank password keeps
    /// the stored one, so only the explicit choice makes a network open.
    pub fn from_form(password: String, open_network: bool) -> Result<Self, ConfigError> {
        match (open_network, password.is_empty()) {
            (true, true) => Ok(Self::Open),
            (true, false) => Err(ConfigError::PasswordForOpenNetwork),
            (false, true) => Ok(Self::Keep),
            (false, false) => Ok(Self::Replace(password)),
        }
    }
}

/// Apply a Wi-Fi form without requiring the write-only values again. Missing
/// target fields preserve their values, as they do outside recovery mode.
pub fn replace_wifi(
    mut current: RuntimeConfig,
    ssid: String,
    password: WifiPassword,
    admin_key: String,
    target_host: Option<String>,
    target_port: Option<u16>,
) -> Result<RuntimeConfig, ConfigError> {
    match password {
        WifiPassword::Keep if current.password.is_empty() => {
            return Err(ConfigError::MissingWifiPassword)
        }
        WifiPassword::Keep => {}
        WifiPassword::Replace(password) => current.password = password,
        WifiPassword::Open => current.password.clear(),
    }
    current.ssid = ssid;
    if !admin_key.is_empty() {
        current.admin_key = admin_key;
    }
    current.update_target(target_host, target_port);
    Ok(current)
}

/// Change memory only after its durable write succeeds. The ESP-IDF HTTP
/// adapter uses this rule for recovery and ordinary settings writes alike.
pub fn commit_after_persist<E>(
    current: &mut RuntimeConfig,
    next: RuntimeConfig,
    persist: impl FnOnce(&RuntimeConfig) -> Result<(), E>,
) -> Result<(), E> {
    persist(&next)?;
    *current = next;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{board, config::RuntimeConfig};

    fn board() -> Board {
        let catalog = board::builtin_catalog().expect("catalog");
        catalog[0].clone()
    }

    fn configured() -> RuntimeConfig {
        RuntimeConfig {
            ssid: "old-wifi".to_owned(),
            password: "old-password".to_owned(),
            target_host: "bridge.local".to_owned(),
            target_port: 39_000,
            transport: Default::default(),
            admin_key: crate::config::TEST_ADMIN_KEY.to_owned(),
            device_name: "Studio".to_owned(),
            auto_update_schedule: AutoUpdateSchedule::Weekly,
            audio: AudioSettings {
                input_line: 1,
                input_gain: 42,
                adc_attenuation_db: 9,
            },
            analog_passthrough_enabled: true,
            led_roles: std::collections::BTreeMap::from([(
                "status".to_owned(),
                crate::led::LedRole::Off,
            )]),
            button_actions: std::collections::BTreeMap::from([(
                "key1".to_owned(),
                crate::button::ButtonAction::Restart,
            )]),
        }
    }

    #[test]
    fn first_setup_uses_descriptor_defaults_and_no_key() {
        let baseline = setup_baseline(&board(), None);
        assert_eq!(baseline.admin_key, "");
        assert!(!baseline.open_network());
        assert_eq!(baseline.audio.input_line, board().default_line());
        assert_eq!(baseline.target_port, 39_000);
    }

    #[test]
    fn fallback_keeps_every_valid_persisted_setting() {
        let persisted = configured();
        assert_eq!(setup_baseline(&board(), Some(persisted.clone())), persisted);
    }

    #[test]
    fn blank_write_only_fields_and_omitted_target_preserve_the_recovery_baseline() {
        let before = configured();
        let after = replace_wifi(
            before.clone(),
            "new-wifi".to_owned(),
            WifiPassword::Keep,
            String::new(),
            None,
            None,
        )
        .unwrap();
        assert_eq!(after.ssid, "new-wifi");
        assert_eq!(after.password, before.password);
        assert_eq!(after.admin_key, before.admin_key);
        assert_eq!(after.target_host, before.target_host);
        assert_eq!(after.target_port, before.target_port);
        assert_eq!(after.audio, before.audio);
        assert_eq!(after.device_name, before.device_name);
        assert_eq!(after.auto_update_schedule, before.auto_update_schedule);
        assert_eq!(
            after.analog_passthrough_enabled,
            before.analog_passthrough_enabled
        );
        assert_eq!(after.led_roles, before.led_roles);
        assert_eq!(after.button_actions, before.button_actions);
    }

    #[test]
    fn only_the_explicit_choice_makes_a_network_open() {
        assert_eq!(
            WifiPassword::from_form(String::new(), true),
            Ok(WifiPassword::Open)
        );
        assert_eq!(
            WifiPassword::from_form(String::new(), false),
            Ok(WifiPassword::Keep)
        );
        assert_eq!(
            WifiPassword::from_form("home-password".to_owned(), false),
            Ok(WifiPassword::Replace("home-password".to_owned()))
        );
        assert_eq!(
            WifiPassword::from_form("home-password".to_owned(), true),
            Err(ConfigError::PasswordForOpenNetwork)
        );
    }

    #[test]
    fn an_open_network_drops_the_stored_password_and_validates() {
        let board = board();
        let open = replace_wifi(
            configured(),
            "cafe".to_owned(),
            WifiPassword::Open,
            String::new(),
            None,
            None,
        )
        .unwrap();
        assert!(open.open_network());
        assert_eq!(open.validate(&board), Ok(()));
    }

    #[test]
    fn a_protected_network_needs_a_password_when_none_is_stored() {
        let mut open = configured();
        open.password.clear();
        let first_setup = setup_baseline(&board(), None);
        for current in [open, first_setup] {
            assert_eq!(
                replace_wifi(
                    current,
                    "home-wifi".to_owned(),
                    WifiPassword::Keep,
                    crate::config::TEST_ADMIN_KEY.to_owned(),
                    None,
                    None,
                ),
                Err(ConfigError::MissingWifiPassword)
            );
        }
    }

    #[test]
    fn commissioning_carries_staged_settings_into_the_first_persisted_configuration() {
        let board = board();
        let mut staged = setup_baseline(&board, None);
        staged.device_name = "Studio".to_owned();
        staged.auto_update_schedule = AutoUpdateSchedule::Weekly;
        staged.audio.input_gain = 3;
        staged
            .led_roles
            .insert(board.leds[0].id.clone(), crate::led::LedRole::Off);
        assert_eq!(staged.validate_staged(&board), Ok(()));

        let commissioned = replace_wifi(
            staged.clone(),
            "home-wifi".to_owned(),
            WifiPassword::Replace("home-password".to_owned()),
            crate::config::TEST_ADMIN_KEY.to_owned(),
            None,
            None,
        )
        .unwrap();

        assert_eq!(commissioned.validate(&board), Ok(()));
        assert_eq!(commissioned.device_name, staged.device_name);
        assert_eq!(
            commissioned.auto_update_schedule,
            staged.auto_update_schedule
        );
        assert_eq!(commissioned.audio, staged.audio);
        assert_eq!(commissioned.led_roles, staged.led_roles);
    }

    #[test]
    fn failed_recovery_write_keeps_the_in_memory_baseline() {
        let mut current = configured();
        let next = replace_wifi(
            current.clone(),
            "new-wifi".to_owned(),
            WifiPassword::Keep,
            String::new(),
            None,
            None,
        )
        .unwrap();

        let result = commit_after_persist(&mut current, next, |_| Err::<(), _>("interrupted"));

        assert_eq!(result, Err("interrupted"));
        assert_eq!(current, configured());
    }

    #[test]
    fn wifi_target_edits_invalidate_only_changed_endpoints() {
        struct Random;
        impl crate::random::RandomBytes for Random {
            fn fill(&mut self, output: &mut [u8]) {
                output.fill(7);
            }
        }
        for (host, port, changed) in [
            (None, None, false),
            (Some("bridge.local"), Some(39_000), false),
            (Some("  bridge.local  "), Some(39_000), false),
            (Some("other-bridge.local"), None, true),
            (None, Some(39_001), true),
            (Some(""), None, true),
        ] {
            let mut current = configured();
            current.transport.keys.stage(&mut Random).unwrap();
            current.transport.keys.mark_pending_verified().unwrap();
            let mut next = replace_wifi(
                current,
                "new-wifi".to_owned(),
                WifiPassword::Keep,
                String::new(),
                host.map(str::to_owned),
                port,
            )
            .unwrap();
            assert_eq!(next.transport.keys.pending_verified(), !changed);
            let activation = next.transport.keys.activate();
            if changed {
                assert_eq!(
                    activation,
                    Err(crate::transport::TransportError::PendingKeyUnverified)
                );
            } else {
                assert_eq!(activation, Ok(()));
            }
        }
    }
}
