//! RFC 7616 digest authentication for mutating HTTP requests.
//!
//! The admin key never crosses the wire: a client proves possession by
//! hashing it with a challenge nonce (SHA-256, `qop=auth`), and the device
//! tracks each nonce's count so a captured exchange authorizes nothing.
//! This module owns the protocol state machine and is host-tested; the
//! HTTP adapter feeds it requests and a clock.

use core::fmt::Write as _;

use sha2::{Digest, Sha256};

use crate::random::RandomBytes;

/// The one account this single-owner device has.
pub const USERNAME: &str = "admin";
/// The protection space named in every challenge. Fixed: the admin key is
/// already unique per device, so the realm only labels the prompt.
pub const REALM: &str = "streamline";

/// How long a minted nonce authorizes requests. Long enough that an unlock
/// window's writes reuse one challenge; short enough that a captured nonce
/// is not a durable artifact.
const NONCE_TTL_MS: u64 = 60 * 60 * 1_000;
const NONCE_BYTES: usize = 16;
/// Live nonces kept, one per concurrent client. A fifth client evicts the
/// oldest and that client re-challenges through `stale`, so the table stays
/// bounded without locking anyone out.
const MAX_NONCES: usize = 4;

/// Outcome of checking one request's `Authorization` header.
#[derive(Debug, Eq, PartialEq)]
pub enum Verdict {
    Authorized,
    /// `stale` means the credentials were not disproven — the nonce was
    /// unknown, expired, or its count was reused — so the client should
    /// retry against a fresh challenge without re-asking for the key.
    Denied {
        stale: bool,
    },
}

struct Nonce {
    value: String,
    issued_at_ms: u64,
    /// Highest accepted nonce count; a request must exceed it, so replaying
    /// a captured exchange fails even byte-identical.
    last_nc: u32,
}

/// Server-side digest state: the live nonce table.
#[derive(Default)]
pub struct DigestAuthenticator {
    nonces: Vec<Nonce>,
}

impl DigestAuthenticator {
    /// Mint a fresh nonce and return the `WWW-Authenticate` header value for
    /// a 401 response. `stale` tells a client its key is still right and
    /// only the nonce needs renewing.
    pub fn challenge(&mut self, random: &mut impl RandomBytes, now_ms: u64, stale: bool) -> String {
        self.nonces
            .retain(|nonce| now_ms.saturating_sub(nonce.issued_at_ms) < NONCE_TTL_MS);
        let mut bytes = [0_u8; NONCE_BYTES];
        random.fill(&mut bytes);
        let value = hex(&bytes);
        if self.nonces.len() >= MAX_NONCES {
            self.nonces.remove(0);
        }
        self.nonces.push(Nonce {
            value: value.clone(),
            issued_at_ms: now_ms,
            last_nc: 0,
        });
        let mut header =
            format!("Digest realm=\"{REALM}\", qop=\"auth\", algorithm=SHA-256, nonce=\"{value}\"");
        if stale {
            header.push_str(", stale=true");
        }
        header
    }

    /// Check a request against the admin key. An empty key authorizes
    /// everything so an unprovisioned device can be commissioned over its
    /// own setup AP; `method` and `uri` must be the ones the request
    /// actually used, because the response hash binds them.
    pub fn authorize(
        &mut self,
        secret: &str,
        method: &str,
        uri: &str,
        authorization: Option<&str>,
        now_ms: u64,
    ) -> Verdict {
        if secret.is_empty() {
            return Verdict::Authorized;
        }
        let denied = Verdict::Denied { stale: false };
        let Some(fields) = authorization.and_then(parse_digest_fields) else {
            return denied;
        };
        let (Some(username), Some(realm), Some(nonce), Some(client_uri), Some(response)) = (
            fields.get("username"),
            fields.get("realm"),
            fields.get("nonce"),
            fields.get("uri"),
            fields.get("response"),
        ) else {
            return denied;
        };
        let (Some(qop), Some(nc), Some(cnonce)) =
            (fields.get("qop"), fields.get("nc"), fields.get("cnonce"))
        else {
            return denied;
        };
        if username.as_str() != USERNAME
            || realm.as_str() != REALM
            || client_uri.as_str() != uri
            || qop.as_str() != "auth"
            || fields
                .get("algorithm")
                .is_some_and(|algorithm| algorithm.as_str() != "SHA-256")
        {
            return denied;
        }
        let Ok(count) = u32::from_str_radix(nc, 16) else {
            return denied;
        };

        let Some(entry) = self.nonces.iter_mut().find(|entry| entry.value == *nonce) else {
            return Verdict::Denied { stale: true };
        };
        if now_ms.saturating_sub(entry.issued_at_ms) >= NONCE_TTL_MS {
            return Verdict::Denied { stale: true };
        }
        if count <= entry.last_nc {
            return Verdict::Denied { stale: true };
        }
        let expected = response_hash(USERNAME, REALM, secret, method, uri, nonce, nc, cnonce);
        if !constant_time_eq(expected.as_bytes(), response.as_bytes()) {
            return denied;
        }
        entry.last_nc = count;
        Verdict::Authorized
    }
}

/// The RFC 7616 `response` value for `algorithm=SHA-256, qop=auth`.
/// `nc` is hashed exactly as the client sent it.
#[allow(clippy::too_many_arguments)]
fn response_hash(
    username: &str,
    realm: &str,
    secret: &str,
    method: &str,
    uri: &str,
    nonce: &str,
    nc: &str,
    cnonce: &str,
) -> String {
    let ha1 = sha256_hex(&format!("{username}:{realm}:{secret}"));
    let ha2 = sha256_hex(&format!("{method}:{uri}"));
    sha256_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"))
}

/// Parse a `Digest` authorization header into its fields. Values may be
/// quoted (commas inside quotes do not split) or bare tokens; `None` for a
/// non-Digest scheme or malformed syntax.
fn parse_digest_fields(header: &str) -> Option<std::collections::HashMap<String, String>> {
    let params = header.strip_prefix("Digest ")?;
    let mut fields = std::collections::HashMap::new();
    let mut rest = params.trim_start();
    while !rest.is_empty() {
        let (name, after_name) = rest.split_once('=')?;
        let name = name.trim().to_ascii_lowercase();
        let (value, remainder) = if let Some(quoted) = after_name.strip_prefix('"') {
            let end = quoted.find('"')?;
            (quoted[..end].to_owned(), &quoted[end + 1..])
        } else {
            match after_name.split_once(',') {
                Some((token, remainder)) => (token.trim().to_owned(), remainder),
                None => (after_name.trim().to_owned(), ""),
            }
        };
        fields.insert(name, value);
        rest = remainder.trim_start().trim_start_matches(',').trim_start();
    }
    Some(fields)
}

fn sha256_hex(input: &str) -> String {
    hex(&Sha256::digest(input.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

/// Length-checked constant-time byte comparison so response validation does
/// not leak through timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::random::RandomBytes;

    struct Scripted(u8);

    impl RandomBytes for Scripted {
        fn fill(&mut self, output: &mut [u8]) {
            output.fill(self.0);
            self.0 = self.0.wrapping_add(1);
        }
    }

    const SECRET: &str = "console-secret";

    fn challenge_nonce(header: &str) -> String {
        let fields = parse_digest_fields(header).expect("challenge parses");
        fields
            .get("nonce")
            .expect("challenge carries nonce")
            .clone()
    }

    fn authorization(method: &str, uri: &str, nonce: &str, nc: &str, secret: &str) -> String {
        let response = response_hash(USERNAME, REALM, secret, method, uri, nonce, nc, "cnonce1");
        format!(
            "Digest username=\"{USERNAME}\", realm=\"{REALM}\", nonce=\"{nonce}\", \
             uri=\"{uri}\", response=\"{response}\", qop=auth, nc={nc}, \
             cnonce=\"cnonce1\", algorithm=SHA-256"
        )
    }

    /// The SHA-256 example from RFC 7616 section 3.9.1, so the hash chain is
    /// pinned to the standard rather than to this implementation.
    #[test]
    fn response_hash_matches_the_rfc_7616_vector() {
        let response = response_hash(
            "Mufasa",
            "http-auth@example.org",
            "Circle of Life",
            "GET",
            "/dir/index.html",
            "7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v",
            "00000001",
            "f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ",
        );
        assert_eq!(
            response,
            "753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"
        );
    }

    #[test]
    fn an_empty_secret_authorizes_commissioning_writes() {
        let mut auth = DigestAuthenticator::default();
        assert_eq!(
            auth.authorize("", "POST", "/api/settings/wifi", None, 0),
            Verdict::Authorized
        );
    }

    #[test]
    fn a_missing_or_malformed_header_is_denied_without_stale() {
        let mut auth = DigestAuthenticator::default();
        for header in [None, Some("Bearer console-secret"), Some("Digest")] {
            assert_eq!(
                auth.authorize(SECRET, "POST", "/api/restart", header, 0),
                Verdict::Denied { stale: false }
            );
        }
    }

    #[test]
    fn a_correct_response_authorizes_and_a_wrong_key_does_not() {
        let mut auth = DigestAuthenticator::default();
        let nonce = challenge_nonce(&auth.challenge(&mut Scripted(1), 0, false));

        let wrong = authorization("POST", "/api/restart", &nonce, "00000001", "wrong-key");
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&wrong), 10),
            Verdict::Denied { stale: false }
        );

        let right = authorization("POST", "/api/restart", &nonce, "00000001", SECRET);
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&right), 10),
            Verdict::Authorized
        );
    }

    /// The replay defense: a captured exchange reuses a nonce count, and the
    /// device refuses it even though every byte is authentic.
    #[test]
    fn a_replayed_nonce_count_is_stale() {
        let mut auth = DigestAuthenticator::default();
        let nonce = challenge_nonce(&auth.challenge(&mut Scripted(1), 0, false));
        let header = authorization("POST", "/api/restart", &nonce, "00000001", SECRET);

        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&header), 10),
            Verdict::Authorized
        );
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&header), 20),
            Verdict::Denied { stale: true }
        );

        let next = authorization("POST", "/api/restart", &nonce, "00000002", SECRET);
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&next), 30),
            Verdict::Authorized
        );
    }

    /// The response hash binds method and URI, so a captured credential
    /// cannot be redirected at a different endpoint.
    #[test]
    fn a_response_for_one_uri_does_not_authorize_another() {
        let mut auth = DigestAuthenticator::default();
        let nonce = challenge_nonce(&auth.challenge(&mut Scripted(1), 0, false));
        let header = authorization("POST", "/api/restart", &nonce, "00000001", SECRET);
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/factory-reset", Some(&header), 10),
            Verdict::Denied { stale: false }
        );
    }

    #[test]
    fn an_unknown_or_expired_nonce_is_stale() {
        let mut auth = DigestAuthenticator::default();
        let unknown = authorization("POST", "/api/restart", "feedface", "00000001", SECRET);
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&unknown), 0),
            Verdict::Denied { stale: true }
        );

        let nonce = challenge_nonce(&auth.challenge(&mut Scripted(1), 0, false));
        let header = authorization("POST", "/api/restart", &nonce, "00000001", SECRET);
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&header), NONCE_TTL_MS),
            Verdict::Denied { stale: true }
        );
    }

    #[test]
    fn the_nonce_table_stays_bounded_and_evicts_the_oldest() {
        let mut auth = DigestAuthenticator::default();
        let first = challenge_nonce(&auth.challenge(&mut Scripted(1), 0, false));
        for _ in 0..MAX_NONCES {
            auth.challenge(&mut Scripted(2), 1, false);
        }
        assert_eq!(auth.nonces.len(), MAX_NONCES);
        let header = authorization("POST", "/api/restart", &first, "00000001", SECRET);
        assert_eq!(
            auth.authorize(SECRET, "POST", "/api/restart", Some(&header), 2),
            Verdict::Denied { stale: true }
        );
    }

    #[test]
    fn a_stale_challenge_says_so_and_a_fresh_one_does_not() {
        let mut auth = DigestAuthenticator::default();
        assert!(auth
            .challenge(&mut Scripted(1), 0, true)
            .ends_with("stale=true"));
        assert!(!auth.challenge(&mut Scripted(1), 0, false).contains("stale"));
    }

    #[test]
    fn digest_fields_parse_quoted_and_bare_values() {
        let fields = parse_digest_fields(
            "Digest username=\"admin\", nc=00000001, uri=\"/api/x,y\", qop=auth",
        )
        .expect("header parses");
        assert_eq!(fields.get("username").map(String::as_str), Some("admin"));
        assert_eq!(fields.get("nc").map(String::as_str), Some("00000001"));
        assert_eq!(fields.get("uri").map(String::as_str), Some("/api/x,y"));
        assert_eq!(fields.get("qop").map(String::as_str), Some("auth"));
    }
}
