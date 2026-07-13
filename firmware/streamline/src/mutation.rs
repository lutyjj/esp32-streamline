//! Typed outcome of a device-configuration mutation.
//!
//! Every write endpoint validates input, consults device state, and persists a
//! change. Collapsing all of those failures into one HTTP status hides whether
//! the caller sent something invalid, hit a state conflict, asked for a
//! capability this mode lacks, or tripped a device fault. This taxonomy carries
//! the distinction so an adapter maps each to the status a client can act on,
//! and so the mapping from the core lifecycle errors is host-testable.

use core::fmt;

use crate::transport::{TransportError, VerifyPendingError};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationError {
    /// Well-formed request, unacceptable values (HTTP 400).
    InvalidInput(String),
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
            Self::InvalidInput(_) => 400,
            Self::Conflict(_) => 409,
            Self::Unavailable(_) => 503,
            Self::Persistence(_) | Self::Internal(_) => 500,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::InvalidInput(message)
            | Self::Conflict(message)
            | Self::Unavailable(message)
            | Self::Persistence(message)
            | Self::Internal(message) => message,
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
    use crate::transport::{TransportError, VerifyPendingError};

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
    fn a_failure_carries_the_underlying_message_to_the_client() {
        let error = MutationError::from(TransportError::PendingKeyExists);
        assert_eq!(
            error.message(),
            TransportError::PendingKeyExists.to_string()
        );
    }
}
