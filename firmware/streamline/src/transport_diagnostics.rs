//! Actionable explanations for failed PCM TLS connection attempts.
//!
//! The TLS adapter reduces a failed handshake to one [`TlsFailure`]; this
//! module owns the wording so every surface — the verify endpoint, the stream
//! log, the console — names what failed and the next step.

use std::net::SocketAddr;

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
}
