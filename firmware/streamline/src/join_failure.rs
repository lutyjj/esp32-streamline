//! Why the station's latest attempt to join the saved Wi-Fi failed, in the
//! terms an owner acts on: wait for the network, or change its details.

use serde::Serialize;

/// ESP-IDF `wifi_err_reason_t` values that decide the class, as ESP-IDF's
/// station guide documents them: `NO_AP_FOUND` when no scan finds the network,
/// the handshake timeouts for a wrong password (or, for 204, a signal too weak
/// to finish), and the two `NO_AP_FOUND_*` codes for a network found with
/// security the saved settings cannot use.
const REASON_4WAY_HANDSHAKE_TIMEOUT: u16 = 15;
const REASON_NO_AP_FOUND: u16 = 201;
const REASON_HANDSHAKE_TIMEOUT: u16 = 204;
const REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: u16 = 210;
const REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD: u16 = 211;

/// The class of the station's latest join failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum JoinFailure {
    /// No scan found the saved network: it is off, out of reach, or renamed.
    NetworkNotFound,
    /// The network's handshake failed, which a wrong password causes and a
    /// signal too weak to finish joining can also cause.
    CredentialsRejected,
    /// The network is there, but its security does not match the saved
    /// settings: it is open and a password is saved, it needs a password and
    /// none is saved, or it uses a mode the device does not support.
    SecurityMismatch,
    /// Any other disconnect reason.
    Other,
}

impl JoinFailure {
    /// Classify a station disconnect reason code.
    pub const fn from_reason(reason: u16) -> Self {
        match reason {
            REASON_NO_AP_FOUND => Self::NetworkNotFound,
            REASON_4WAY_HANDSHAKE_TIMEOUT | REASON_HANDSHAKE_TIMEOUT => Self::CredentialsRejected,
            REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY | REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD => {
                Self::SecurityMismatch
            }
            _ => Self::Other,
        }
    }

    /// Stable API name for this class.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NetworkNotFound => "network-not-found",
            Self::CredentialsRejected => "credentials-rejected",
            Self::SecurityMismatch => "security-mismatch",
            Self::Other => "other",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::JoinFailure;

    #[test]
    fn a_network_no_scan_finds_reads_as_not_found() {
        assert_eq!(JoinFailure::from_reason(201), JoinFailure::NetworkNotFound);
    }

    #[test]
    fn a_failed_handshake_reads_as_rejected() {
        for reason in [15, 204] {
            assert_eq!(
                JoinFailure::from_reason(reason),
                JoinFailure::CredentialsRejected,
                "{reason}"
            );
        }
    }

    #[test]
    fn a_network_found_with_other_security_reads_as_a_mismatch() {
        for reason in [210, 211] {
            assert_eq!(
                JoinFailure::from_reason(reason),
                JoinFailure::SecurityMismatch,
                "{reason}"
            );
        }
    }

    #[test]
    fn a_dropped_or_weak_association_names_no_cause_it_cannot_prove() {
        // Beacon loss and an access point leaving are outages, and a network that
        // is present with too weak a signal is neither gone nor a settings problem.
        for reason in [1, 8, 200, 202, 203, 205, 212] {
            assert_eq!(
                JoinFailure::from_reason(reason),
                JoinFailure::Other,
                "{reason}"
            );
        }
    }

    #[test]
    fn the_wire_name_matches_the_api_name() {
        for failure in [
            JoinFailure::NetworkNotFound,
            JoinFailure::CredentialsRejected,
            JoinFailure::SecurityMismatch,
            JoinFailure::Other,
        ] {
            assert_eq!(
                serde_json::to_value(failure).unwrap(),
                serde_json::Value::from(failure.as_str())
            );
        }
    }
}
