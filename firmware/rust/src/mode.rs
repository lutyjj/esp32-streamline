//! Explicit application lifecycle policy.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetupReason {
    MissingConfiguration,
    WifiTimeout,
    InvalidTarget,
    TargetResolutionFailed,
    SerialCommand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BootMode {
    Setup(SetupReason),
    Streaming,
}

pub const fn select_boot_mode(has_network_configuration: bool) -> BootMode {
    if has_network_configuration {
        BootMode::Streaming
    } else {
        BootMode::Setup(SetupReason::MissingConfiguration)
    }
}

#[cfg(test)]
mod tests {
    use super::{select_boot_mode, BootMode, SetupReason};

    #[test]
    fn unconfigured_devices_enter_setup_mode() {
        assert_eq!(
            select_boot_mode(false),
            BootMode::Setup(SetupReason::MissingConfiguration)
        );
    }

    #[test]
    fn configured_devices_attempt_streaming() {
        assert_eq!(select_boot_mode(true), BootMode::Streaming);
    }
}
