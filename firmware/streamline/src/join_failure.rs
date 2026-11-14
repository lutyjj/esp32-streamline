//! Why the station's latest attempt to join the saved Wi-Fi failed, in the
//! terms an owner acts on: wait for the network, or change its details.

use serde::Serialize;

/// ESP-IDF `wifi_err_reason_t` values that decide the class, as ESP-IDF's
/// station guide documents them: `NO_AP_FOUND` when no scan finds the network,
/// and the handshake timeouts for a wrong password (or, for 204, a signal too
/// weak to finish).
const REASON_4WAY_HANDSHAKE_TIMEOUT: u16 = 15;
const REASON_NO_AP_FOUND: u16 = 201;
const REASON_HANDSHAKE_TIMEOUT: u16 = 204;

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
    /// Any other disconnect reason.
    Other,
}

impl JoinFailure {
    /// Classify a station disconnect reason code.
    pub const fn from_reason(reason: u16) -> Self {
        match reason {
            REASON_NO_AP_FOUND => Self::NetworkNotFound,
            REASON_4WAY_HANDSHAKE_TIMEOUT | REASON_HANDSHAKE_TIMEOUT => Self::CredentialsRejected,
            _ => Self::Other,
        }
    }

    /// Stable API name for this class.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NetworkNotFound => "network-not-found",
            Self::CredentialsRejected => "credentials-rejected",
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
    fn a_dropped_or_incompatible_association_names_no_cause_it_cannot_prove() {
        // Beacon loss and an access point leaving are outages, and a network that
        // is present with an unusable security mode or signal is neither gone nor
        // a password problem.
        for reason in [1, 8, 200, 202, 203, 205, 210, 211, 212] {
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
            JoinFailure::Other,
        ] {
            assert_eq!(
                serde_json::to_value(failure).unwrap(),
                serde_json::Value::from(failure.as_str())
            );
        }
    }
}
