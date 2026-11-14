//! The boot mode and the write policy it grants.

use serde::Serialize;

use crate::mutation::MutationError;

/// The boot contract: the one decision made at startup that fixes which
/// services run and who may write until the next reboot.
///
/// A state earns a variant here only if it changes the service set or the
/// trust model, and only at boot. Anything that changes at runtime is status
/// (`metrics.playing`, `ota.phase`); anything that is a configuration
/// difference reads from config (an empty `target_host` is "no bridge yet",
/// not a mode).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[cfg_attr(feature = "api-spec", schema(as = DeviceMode))]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Unconfigured: own open AP, writes accepted so a first admin key can be
    /// set. Capture and streaming are down.
    Setup,
    /// A provisioned device that could not join its saved Wi-Fi starts the
    /// setup AP with its validated state, keeps writes behind its key, and
    /// retries the saved network in the background so it rejoins on its own. A
    /// persisted local analog route remains independent of that network fault.
    Recovery,
    /// Station on the home network: console behind the admin key, capture
    /// running; the TCP stream runs only while a bridge target is configured.
    Provisioned,
}

/// Where a configuration write lands.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigWrite {
    /// Validate in full and commit a durable generation.
    Persist,
    /// Validate everything commissioning does not supply, then keep the value
    /// in memory. Setup mode has no durable configuration to amend, and
    /// [`crate::recovery::replace_wifi`] carries the staged values into the
    /// first persisted generation, so a staged write still reaches flash.
    Stage,
}

impl ConfigWrite {
    /// Whether a value that only a boot applies calls for a restart now. A
    /// staged value waits for the restart that ends commissioning, and an
    /// earlier restart would discard it.
    pub const fn restart_applies(self) -> bool {
        matches!(self, Self::Persist)
    }
}

impl Mode {
    /// Stable API and metrics name for this mode.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Recovery => "recovery",
            Self::Provisioned => "provisioned",
        }
    }

    pub const fn setup_network_active(self) -> bool {
        matches!(self, Self::Setup | Self::Recovery)
    }

    pub const fn config_write(self) -> ConfigWrite {
        match self {
            Self::Setup => ConfigWrite::Stage,
            Self::Recovery | Self::Provisioned => ConfigWrite::Persist,
        }
    }

    /// Refuse `capability` on a device that has no durable configuration yet,
    /// naming the step the caller must take instead of the missing Wi-Fi
    /// credentials a full validation would blame. This is the exception to
    /// staging, for operations that are meaningless before commissioning; each
    /// caller states why it is one.
    pub fn require_commissioned(self, capability: &str) -> Result<(), MutationError> {
        match self.config_write() {
            ConfigWrite::Persist => Ok(()),
            ConfigWrite::Stage => Err(MutationError::Unavailable(format!(
                "{capability} needs a commissioned device; complete Wi-Fi setup first"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ConfigWrite, Mode};

    #[test]
    fn setup_and_recovery_both_show_the_setup_indicator() {
        assert!(Mode::Setup.setup_network_active());
        assert!(Mode::Recovery.setup_network_active());
        assert!(!Mode::Provisioned.setup_network_active());
    }

    #[test]
    fn the_wire_name_tells_recovery_apart_from_first_setup() {
        for mode in [Mode::Setup, Mode::Recovery, Mode::Provisioned] {
            assert_eq!(
                serde_json::to_value(mode).unwrap(),
                serde_json::Value::from(mode.as_str())
            );
        }
        assert_ne!(Mode::Recovery.as_str(), Mode::Setup.as_str());
    }

    #[test]
    fn only_an_uncommissioned_device_stages_its_writes() {
        assert_eq!(Mode::Setup.config_write(), ConfigWrite::Stage);
        assert_eq!(Mode::Recovery.config_write(), ConfigWrite::Persist);
        assert_eq!(Mode::Provisioned.config_write(), ConfigWrite::Persist);
    }

    #[test]
    fn a_staged_value_waits_for_commissioning_instead_of_a_restart() {
        assert!(!Mode::Setup.config_write().restart_applies());
        assert!(Mode::Recovery.config_write().restart_applies());
        assert!(Mode::Provisioned.config_write().restart_applies());
    }

    #[test]
    fn a_capability_that_needs_commissioning_answers_503_naming_that_precondition() {
        let error = Mode::Setup
            .require_commissioned("the transport key lifecycle")
            .expect_err("setup mode has no durable configuration");

        assert_eq!(error.status(), 503);
        assert!(
            error.message().contains("the transport key lifecycle")
                && error.message().contains("Wi-Fi setup"),
            "{error}"
        );
    }

    #[test]
    fn a_commissioned_device_grants_every_capability() {
        assert_eq!(Mode::Recovery.require_commissioned("a capability"), Ok(()));
        assert_eq!(
            Mode::Provisioned.require_commissioned("a capability"),
            Ok(())
        );
    }
}
