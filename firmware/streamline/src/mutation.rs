//! Typed outcome of a device-configuration mutation.
//!
//! Every write endpoint validates input, consults device state, and persists a
//! change. Collapsing all of those failures into one HTTP status hides whether
//! the caller sent something invalid, hit a state conflict, asked for a
//! capability this mode lacks, or tripped a device fault. This taxonomy carries
//! the distinction so an adapter maps each to the status a client can act on,
//! and so the mapping from the core lifecycle errors is host-testable.

use core::fmt;

use crate::{
    board::BoardUpdateError,
    config::ConfigError,
    transport::{TransportError, VerifyPendingError},
};

/// The request fields a refusal can name, as the write requests name them.
/// The contract generation checks that each belongs to some request.
pub mod field {
    pub const SSID: &str = "ssid";
    pub const PASSWORD: &str = "password";
    pub const TARGET_HOST: &str = "target_host";
    pub const TARGET_PORT: &str = "target_port";
    pub const INPUT_LINE: &str = "input_line";
    pub const INPUT_GAIN: &str = "input_gain";
    pub const ADC_ATTENUATION_DB: &str = "adc_attenuation_db";
    pub const ENABLED: &str = "enabled";
    pub const ID: &str = "id";
    pub const ADMIN_KEY: &str = "admin_key";
    pub const NAME: &str = "name";
    pub const BOARD_ID: &str = "board_id";
    pub const DESCRIPTOR: &str = "descriptor";
    pub const CATALOG: &str = "catalog";
    pub const PROFILE_ID: &str = "profile_id";
    pub const URL: &str = "url";
    pub const SHA256: &str = "sha256";

    pub const ALL: &[&str] = &[
        SSID,
        PASSWORD,
        TARGET_HOST,
        TARGET_PORT,
        INPUT_LINE,
        INPUT_GAIN,
        ADC_ATTENUATION_DB,
        ENABLED,
        ID,
        ADMIN_KEY,
        NAME,
        BOARD_ID,
        DESCRIPTOR,
        CATALOG,
        PROFILE_ID,
        URL,
        SHA256,
    ];
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationError {
    /// Well-formed request, unacceptable values (HTTP 400).
    InvalidInput(String),
    /// One request field holds a value the device refuses (HTTP 400), named
    /// as the request names it so a client can show the reason beside it.
    InvalidField {
        field: &'static str,
        message: String,
    },
    /// The device's current state forbids this change right now (HTTP 409).
    Conflict(String),
    /// The capability is absent in this mode or on this hardware (HTTP 503).
    Unavailable(String),
    /// A durable write failed, so the change did not persist (HTTP 500).
    Persistence(String),
    /// An internal invariant broke, such as a poisoned lock (HTTP 500).
    Internal(String),
}

impl MutationError {
    pub fn status(&self) -> u16 {
        match self {
            Self::InvalidInput(_) | Self::InvalidField { .. } => 400,
            Self::Conflict(_) => 409,
            Self::Unavailable(_) => 503,
            Self::Persistence(_) | Self::Internal(_) => 500,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::InvalidInput(message)
            | Self::InvalidField { message, .. }
            | Self::Conflict(message)
            | Self::Unavailable(message)
            | Self::Persistence(message)
            | Self::Internal(message) => message,
        }
    }

    /// The request field the device refuses, when one is at fault.
    pub fn field(&self) -> Option<&'static str> {
        match self {
            Self::InvalidField { field, .. } => Some(field),
            _ => None,
        }
    }
}

impl fmt::Display for MutationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for MutationError {}

impl From<TransportError> for MutationError {
    fn from(error: TransportError) -> Self {
        let message = error.to_string();
        match error {
            // The current key state forbids the operation: a client should back
            // out or finish the prior step, not resend different values.
            TransportError::PendingKeyExists
            | TransportError::RollbackKeyExists
            | TransportError::DuplicateKeyId
            | TransportError::NoPendingKey
            | TransportError::PendingKeyUnverified
            | TransportError::NoActiveKey
            | TransportError::NoRollbackKey => Self::Conflict(message),
            // The submitted version or key values are themselves unacceptable.
            TransportError::UnsupportedVersion
            | TransportError::InvalidKeyState
            | TransportError::InvalidKeyId => Self::InvalidInput(message),
        }
    }
}

impl From<ConfigError> for MutationError {
    fn from(error: ConfigError) -> Self {
        let message = error.to_string();
        let field = match error {
            ConfigError::MissingSsid | ConfigError::MalformedSsid => field::SSID,
            ConfigError::MalformedWifiPassword
            | ConfigError::MissingWifiPassword
            | ConfigError::PasswordForOpenNetwork => field::PASSWORD,
            ConfigError::MalformedTargetHost => field::TARGET_HOST,
            ConfigError::InvalidTargetPort => field::TARGET_PORT,
            ConfigError::InvalidInputLine => field::INPUT_LINE,
            ConfigError::InvalidInputGain => field::INPUT_GAIN,
            ConfigError::InvalidAdcAttenuation => field::ADC_ATTENUATION_DB,
            ConfigError::UnsupportedAnalogPassthrough => field::ENABLED,
            ConfigError::UnknownLed | ConfigError::UnknownButton => field::ID,
            ConfigError::MalformedAdminKey => field::ADMIN_KEY,
            ConfigError::DeviceNameTooLong => field::NAME,
            ConfigError::InvalidTransport(_) => return Self::InvalidInput(message),
        };
        Self::InvalidField { field, message }
    }
}

impl From<BoardUpdateError> for MutationError {
    fn from(error: BoardUpdateError) -> Self {
        let message = error.to_string();
        let field = match error {
            BoardUpdateError::UnknownBoard(_) => field::BOARD_ID,
            BoardUpdateError::DescriptorTooLarge { .. }
            | BoardUpdateError::InvalidDescriptor(_)
            | BoardUpdateError::BuiltInId(_) => field::DESCRIPTOR,
            BoardUpdateError::ConflictingSelection | BoardUpdateError::MissingSelection => {
                return Self::InvalidInput(message)
            }
        };
        Self::InvalidField { field, message }
    }
}

impl From<VerifyPendingError> for MutationError {
    fn from(error: VerifyPendingError) -> Self {
        let message = error.to_string();
        match error {
            // No pending key to verify is a state conflict; a missing target or a
            // bridge that rejected the key is something the caller must fix.
            VerifyPendingError::NoPendingKey => Self::Conflict(message),
            VerifyPendingError::MissingTarget | VerifyPendingError::Rejected(_) => {
                Self::InvalidInput(message)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::MutationError;
    use crate::{
        config::ConfigError,
        transport::{TransportError, VerifyPendingError},
    };

    #[test]
    fn transport_key_state_conflicts_answer_409_not_400() {
        // Staging over a pending key, activating an unverified key, or rolling
        // back with nothing to roll back to are conflicts with device state,
        // not malformed requests — a client distinguishes "retry differently"
        // from "finish or abandon the prior step".
        for error in [
            TransportError::PendingKeyExists,
            TransportError::RollbackKeyExists,
            TransportError::DuplicateKeyId,
            TransportError::NoPendingKey,
            TransportError::PendingKeyUnverified,
            TransportError::NoActiveKey,
            TransportError::NoRollbackKey,
        ] {
            assert_eq!(MutationError::from(error).status(), 409, "{error:?}");
        }
    }

    #[test]
    fn malformed_transport_values_answer_400() {
        for error in [
            TransportError::UnsupportedVersion,
            TransportError::InvalidKeyState,
            TransportError::InvalidKeyId,
        ] {
            assert_eq!(MutationError::from(error).status(), 400, "{error:?}");
        }
    }

    #[test]
    fn key_verification_splits_conflict_from_bad_request() {
        assert_eq!(
            MutationError::from(VerifyPendingError::NoPendingKey).status(),
            409
        );
        assert_eq!(
            MutationError::from(VerifyPendingError::MissingTarget).status(),
            400
        );
        assert_eq!(
            MutationError::from(VerifyPendingError::Rejected("bad key".to_owned())).status(),
            400
        );
    }

    #[test]
    fn a_refused_setting_names_the_request_field_that_carries_it() {
        let error = MutationError::from(ConfigError::MalformedWifiPassword);
        assert_eq!(error.status(), 400);
        assert_eq!(error.field(), Some("password"));
        assert_eq!(
            error.message(),
            ConfigError::MalformedWifiPassword.to_string()
        );
        assert_eq!(
            MutationError::from(ConfigError::DeviceNameTooLong).field(),
            Some("name")
        );
        let transport = MutationError::from(ConfigError::InvalidTransport(
            TransportError::InvalidKeyState,
        ));
        assert_eq!((transport.status(), transport.field()), (400, None));
    }

    #[test]
    fn a_failure_carries_the_underlying_message_to_the_client() {
        let error = MutationError::from(TransportError::PendingKeyExists);
        assert_eq!(
            error.message(),
            TransportError::PendingKeyExists.to_string()
        );
    }
}
