//! Setup-mode configuration baselines and Wi-Fi recovery edits.

use crate::{
    board::Board,
    config::{AudioSettings, AutoUpdateSchedule, RuntimeConfig},
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
        admin_secret: String::new(),
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

/// Apply a Wi-Fi form without requiring the write-only values again. Missing
/// target fields preserve their values, as they do outside recovery mode.
pub fn replace_wifi(
    current: RuntimeConfig,
    ssid: String,
    password: String,
    admin_secret: String,
    target_host: Option<String>,
    target_port: Option<u16>,
) -> RuntimeConfig {
    RuntimeConfig {
        ssid,
        password: if password.is_empty() {
            current.password
        } else {
            password
        },
        target_host: target_host.unwrap_or(current.target_host),
        target_port: target_port.unwrap_or(current.target_port),
        transport: current.transport,
        admin_secret: if admin_secret.is_empty() {
            current.admin_secret
        } else {
            admin_secret
        },
        device_name: current.device_name,
        auto_update_schedule: current.auto_update_schedule,
        audio: current.audio,
        analog_passthrough_enabled: current.analog_passthrough_enabled,
        led_roles: current.led_roles,
        button_actions: current.button_actions,
    }
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
            admin_secret: crate::config::TEST_ADMIN_SECRET.to_owned(),
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
        assert_eq!(baseline.admin_secret, "");
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
            String::new(),
            String::new(),
            None,
            None,
        );
        assert_eq!(after.ssid, "new-wifi");
        assert_eq!(after.password, before.password);
        assert_eq!(after.admin_secret, before.admin_secret);
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
    fn failed_recovery_write_keeps_the_in_memory_baseline() {
        let mut current = configured();
        let next = replace_wifi(
            current.clone(),
            "new-wifi".to_owned(),
            String::new(),
            String::new(),
            None,
            None,
        );

        let result = commit_after_persist(&mut current, next, |_| Err::<(), _>("interrupted"));

        assert_eq!(result, Err("interrupted"));
        assert_eq!(current, configured());
    }
}
