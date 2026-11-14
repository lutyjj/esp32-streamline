//! Why the station's latest attempt to join the saved Wi-Fi failed, in the
//! terms an owner acts on: wait for the network, or change its details.

use serde::Serialize;

/// ESP-IDF `wifi_err_reason_t` values that decide the class. The driver
/// reports a WPA2 handshake that a wrong password stalls as
/// `HANDSHAKE_TIMEOUT` (or the 802.11 `4WAY_HANDSHAKE_TIMEOUT`).
const REASON_4WAY_HANDSHAKE_TIMEOUT: u16 = 15;
const REASON_NO_AP_FOUND: u16 = 201;
const REASON_AUTH_FAIL: u16 = 202;
const REASON_HANDSHAKE_TIMEOUT: u16 = 204;
const REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: u16 = 210;
const REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD: u16 = 211;
const REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD: u16 = 212;

/// The class of the station's latest join failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum JoinFailure {
    /// No access point with the saved name and a usable security mode is in
    /// range: the network is off, out of reach, or renamed.
    NetworkNotFound,
    /// The network answered and refused the saved password.
    CredentialsRejected,
    /// Any other disconnect reason.
    Other,
}

impl JoinFailure {
    /// Classify a station disconnect reason code.
    pub const fn from_reason(reason: u16) -> Self {
        match reason {
            REASON_NO_AP_FOUND
            | REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY
            | REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD
            | REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD => Self::NetworkNotFound,
            REASON_4WAY_HANDSHAKE_TIMEOUT | REASON_AUTH_FAIL | REASON_HANDSHAKE_TIMEOUT => {
                Self::CredentialsRejected
            }
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
    fn a_missing_or_incompatible_access_point_reads_as_not_found() {
        for reason in [201, 210, 211, 212] {
            assert_eq!(
                JoinFailure::from_reason(reason),
                JoinFailure::NetworkNotFound,
                "{reason}"
            );
        }
    }

    #[test]
    fn a_refused_password_reads_as_rejected() {
        for reason in [15, 202, 204] {
            assert_eq!(
                JoinFailure::from_reason(reason),
                JoinFailure::CredentialsRejected,
                "{reason}"
            );
        }
    }

    #[test]
    fn a_dropped_association_names_no_cause_it_cannot_prove() {
        // Beacon loss and an access point leaving are outages, not a verdict on
        // the saved network.
        for reason in [1, 8, 200, 203, 205] {
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
