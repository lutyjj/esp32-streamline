//! The boot mode and the write policy it grants.

use crate::mutation::MutationError;

/// The boot contract: the one decision made at startup that fixes which
/// services run and who may write until the next reboot.
///
/// A state earns a variant here only if it changes the service set or the
/// trust model, and only at boot. Anything that changes at runtime is status
/// (`metrics.playing`, `ota.phase`); anything that is a configuration
/// difference reads from config (an empty `target_host` is "no bridge yet",
/// not a mode).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

impl Mode {
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
    fn only_an_uncommissioned_device_stages_its_writes() {
        assert_eq!(Mode::Setup.config_write(), ConfigWrite::Stage);
        assert_eq!(Mode::Recovery.config_write(), ConfigWrite::Persist);
        assert_eq!(Mode::Provisioned.config_write(), ConfigWrite::Persist);
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
