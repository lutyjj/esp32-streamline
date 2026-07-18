//! Actionable explanations for failed PCM TLS connection attempts.
//!
//! The TLS adapter reduces a failed handshake to one [`TlsFailure`]; this
//! module owns the wording so every surface — the verify endpoint, the stream
//! log, the console — names what failed and the next step.

use std::net::SocketAddr;

/// The esp-tls and mbedTLS codes the classifier maps, mirrored numerically so
/// classification stays host-testable. The TLS adapter pins every shared value
/// against the generated ESP-IDF bindings with compile-time asserts.
pub mod tls_codes {
    pub const ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME: i32 = 0x8001;
    pub const ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET: i32 = 0x8002;
    pub const ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST: i32 = 0x8004;
    pub const ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT: i32 = 0x8006;
    pub const ESP_ERR_ESP_TLS_TCP_CLOSED_FIN: i32 = 0x8008;
    pub const ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT: i32 = 0x8009;
    pub const MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE: i32 = -0x7780;
    pub const MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE: i32 = -0x6E00;
    pub const MBEDTLS_ERR_SSL_CONN_EOF: i32 = -0x7280;
    pub const MBEDTLS_ERR_SSL_INVALID_RECORD: i32 = -0x7200;
    pub const MBEDTLS_ERR_SSL_UNEXPECTED_MESSAGE: i32 = -0x7700;
    pub const MBEDTLS_ERR_SSL_TIMEOUT: i32 = -0x6800;
    /// mbedTLS network-layer codes esp-tls forwards; absent from the
    /// generated bindings because only the ssl-layer headers are bound.
    pub const MBEDTLS_ERR_NET_RECV_FAILED: i32 = -0x004C;
    pub const MBEDTLS_ERR_NET_CONN_RESET: i32 = -0x0050;
}

/// Reduce a captured esp-tls error record to one [`TlsFailure`].
///
/// `last_error` is the esp-tls layer's own error code; `captured_stack` is
/// the mbedTLS return value as esp-tls stores it — negated — so it is flipped
/// back before comparing against the `MBEDTLS_ERR_*` codes.
pub fn classify_tls_failure(last_error: i32, captured_stack: i32) -> TlsFailure {
    use tls_codes::*;
    let detail = -captured_stack;
    match last_error {
        ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME
        | ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET
        | ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST => TlsFailure::Unreachable,
        ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT | ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT => {
            TlsFailure::Timeout
        }
        ESP_ERR_ESP_TLS_TCP_CLOSED_FIN => TlsFailure::ClosedBeforeHandshake,
        code => match detail {
            MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE | MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE => {
                TlsFailure::CredentialRejected
            }
            MBEDTLS_ERR_SSL_CONN_EOF
            | MBEDTLS_ERR_SSL_INVALID_RECORD
            | MBEDTLS_ERR_SSL_UNEXPECTED_MESSAGE
            | MBEDTLS_ERR_NET_RECV_FAILED
            | MBEDTLS_ERR_NET_CONN_RESET => TlsFailure::ClosedBeforeHandshake,
            MBEDTLS_ERR_SSL_TIMEOUT => TlsFailure::Timeout,
            _ => TlsFailure::Other {
                code,
                detail: captured_stack,
            },
        },
    }
}

/// Where a failed TLS connection attempt stopped, as observed by the client.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TlsFailure {
    /// TCP connect failed: nothing accepts connections on the target port.
    Unreachable,
    /// The connect or handshake ran out of time.
    Timeout,
    /// The peer closed or reset the connection without answering TLS — the
    /// signature of a listener still in cleartext mode.
    ClosedBeforeHandshake,
    /// The peer answered TLS and refused the offered credential.
    CredentialRejected,
    /// An unclassified failure, carrying the raw esp-tls and detail codes.
    Other { code: i32, detail: i32 },
}

impl TlsFailure {
    /// One sentence naming the failure and the owner's next step.
    pub fn describe(&self, target: &SocketAddr) -> String {
        match self {
            Self::Unreachable => format!(
                "nothing is listening at {target} — check the bridge address \
                 and that this port matches the bridge's PCM port"
            ),
            Self::Timeout => format!(
                "{target} did not answer in time — check the address and the \
                 network path to the bridge"
            ),
            Self::ClosedBeforeHandshake => format!(
                "{target} closed the connection without speaking TLS — the \
                 bridge is likely still in cleartext mode; switch it to \
                 encrypted, then retry"
            ),
            Self::CredentialRejected => format!(
                "the bridge at {target} does not accept this credential — add \
                 the device's pending credential in the bridge console, then \
                 retry"
            ),
            Self::Other { code, detail } => format!(
                "TLS handshake with {target} failed (esp-tls error {code}, \
                 detail {detail})"
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> SocketAddr {
        "192.0.2.20:39000".parse().expect("valid test address")
    }

    #[test]
    fn every_failure_names_the_target_and_a_next_step() {
        let cases: [(TlsFailure, &str); 4] = [
            (TlsFailure::Unreachable, "bridge's PCM port"),
            (TlsFailure::Timeout, "network path"),
            (TlsFailure::ClosedBeforeHandshake, "cleartext mode"),
            (TlsFailure::CredentialRejected, "bridge console"),
        ];
        for (failure, next_step) in cases {
            let message = failure.describe(&target());
            assert!(message.contains("192.0.2.20:39000"), "{message}");
            assert!(message.contains(next_step), "{message}");
        }
    }

    #[test]
    fn unclassified_failures_keep_the_raw_codes() {
        let message = TlsFailure::Other {
            code: 0x8004,
            detail: -0x7780,
        }
        .describe(&target());
        assert!(message.contains("32772"), "{message}");
        assert!(message.contains("-30592"), "{message}");
    }

    #[test]
    fn every_esp_tls_code_classifies_to_its_failure() {
        use tls_codes::*;
        let cases = [
            (
                ESP_ERR_ESP_TLS_CANNOT_RESOLVE_HOSTNAME,
                TlsFailure::Unreachable,
            ),
            (
                ESP_ERR_ESP_TLS_CANNOT_CREATE_SOCKET,
                TlsFailure::Unreachable,
            ),
            (
                ESP_ERR_ESP_TLS_FAILED_CONNECT_TO_HOST,
                TlsFailure::Unreachable,
            ),
            (ESP_ERR_ESP_TLS_CONNECTION_TIMEOUT, TlsFailure::Timeout),
            (
                ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT,
                TlsFailure::Timeout,
            ),
            (
                ESP_ERR_ESP_TLS_TCP_CLOSED_FIN,
                TlsFailure::ClosedBeforeHandshake,
            ),
        ];
        for (code, expected) in cases {
            assert_eq!(classify_tls_failure(code, 0), expected, "code {code}");
        }
    }

    #[test]
    fn every_mbedtls_detail_classifies_through_the_negated_capture() {
        use tls_codes::*;
        let cases = [
            (
                MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE,
                TlsFailure::CredentialRejected,
            ),
            (
                MBEDTLS_ERR_SSL_HANDSHAKE_FAILURE,
                TlsFailure::CredentialRejected,
            ),
            (MBEDTLS_ERR_SSL_CONN_EOF, TlsFailure::ClosedBeforeHandshake),
            (
                MBEDTLS_ERR_SSL_INVALID_RECORD,
                TlsFailure::ClosedBeforeHandshake,
            ),
            (
                MBEDTLS_ERR_SSL_UNEXPECTED_MESSAGE,
                TlsFailure::ClosedBeforeHandshake,
            ),
            (
                MBEDTLS_ERR_NET_RECV_FAILED,
                TlsFailure::ClosedBeforeHandshake,
            ),
            (
                MBEDTLS_ERR_NET_CONN_RESET,
                TlsFailure::ClosedBeforeHandshake,
            ),
            (MBEDTLS_ERR_SSL_TIMEOUT, TlsFailure::Timeout),
        ];
        for (detail, expected) in cases {
            // esp-tls stores the mbedTLS return negated; the classifier flips
            // it back.
            assert_eq!(
                classify_tls_failure(0, -detail),
                expected,
                "detail {detail}"
            );
        }
    }

    #[test]
    fn unmapped_codes_fall_back_to_other_with_the_raw_capture() {
        assert_eq!(
            classify_tls_failure(0x8005, 999),
            TlsFailure::Other {
                code: 0x8005,
                detail: 999,
            }
        );
        // A null or unreadable error record classifies as Other, not a panic.
        assert_eq!(
            classify_tls_failure(0, 0),
            TlsFailure::Other { code: 0, detail: 0 }
        );
    }
}
