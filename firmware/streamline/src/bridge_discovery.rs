//! Bridges a DNS-SD browse found, parsed from answers any network host can send.
//!
//! `docs/bridge.md#discovery` defines the records. A candidate is a hint: the
//! device streams only to the target its owner saves.

use std::{
    net::Ipv4Addr,
    time::{Duration, Instant},
};

use serde::Serialize;

pub const SERVICE: &str = "_streamline";
pub const PROTO: &str = "_tcp";
pub const TXT_VERSION: &str = "1";
/// Browse window; ESP-IDF's querier repeats the query every second within it.
pub const BROWSE_MILLIS: u32 = 3_000;
/// Answers one browse keeps, which bounds the heap a flood of answers can claim.
/// ESP-IDF ends the browse early once this many answers arrive.
pub const MAX_ANSWERS: usize = 8;
/// A request this soon after the last browse ended gets that browse's
/// bridges, so requests queued behind a browse do not each browse again.
pub const REUSE_WINDOW: Duration = Duration::from_secs(2);

/// The last browse's bridges, reused within [`REUSE_WINDOW`] of its end.
#[derive(Debug, Default)]
pub struct RecentBrowse {
    last: Option<(Instant, Vec<DiscoveredBridge>)>,
}

impl RecentBrowse {
    /// The bridges for a request: the last browse's within the window,
    /// otherwise a fresh `browse`. `now` reads the monotonic clock. A failed
    /// browse is not kept.
    pub fn bridges<E>(
        &mut self,
        now: impl Fn() -> Instant,
        browse: impl FnOnce() -> Result<Vec<Answer>, E>,
    ) -> Result<Vec<DiscoveredBridge>, E> {
        if let Some((ended, found)) = &self.last {
            if now().saturating_duration_since(*ended) < REUSE_WINDOW {
                return Ok(found.clone());
            }
        }
        let found = bridges(browse()?);
        self.last = Some((now(), found.clone()));
        Ok(found)
    }
}

/// One browse answer as received. Its bytes stay raw until [`bridges`] parses them.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Answer {
    pub instance: Option<Vec<u8>>,
    pub port: u16,
    /// Seconds the answer stays valid; zero is a DNS-SD goodbye.
    pub ttl: u32,
    /// Key and value bytes; a key without `=` has no value.
    pub txt: Vec<(Vec<u8>, Option<Vec<u8>>)>,
    pub addresses: Vec<Ipv4Addr>,
}

/// A bridge the owner can pick to fill in the stream target.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
pub struct DiscoveredBridge {
    /// The bridge's DNS-SD instance name, such as `StreamLine Bridge`.
    pub name: String,
    /// IPv4 address for the stream target host.
    pub host: String,
    /// PCM port for the stream target port.
    pub port: u16,
    /// Port of the bridge console and API, when the bridge advertises one.
    pub http_port: Option<u16>,
}

/// The bridges among one browse's answers, one per instance name, ordered by
/// name and then address.
pub fn bridges(answers: impl IntoIterator<Item = Answer>) -> Vec<DiscoveredBridge> {
    let mut found: Vec<(DiscoveredBridge, Ipv4Addr)> =
        answers.into_iter().filter_map(parse).collect();
    found.sort_by(|(a, a_host), (b, b_host)| {
        (&a.name, a_host, a.port).cmp(&(&b.name, b_host, b.port))
    });
    found.dedup_by(|later, earlier| later.0.name == earlier.0.name);
    found.into_iter().map(|(bridge, _)| bridge).collect()
}

fn parse(answer: Answer) -> Option<(DiscoveredBridge, Ipv4Addr)> {
    if answer.ttl == 0 || answer.port == 0 {
        return None;
    }
    // RFC 6763 section 6.7: ignore a TXT format version this device does not know.
    if txt(&answer, "txtvers")? != TXT_VERSION.as_bytes() {
        return None;
    }
    let name = String::from_utf8(answer.instance.clone()?).ok()?;
    if name.is_empty() || name.chars().any(char::is_control) {
        return None;
    }
    // A bridge advertises one address; a second one is another sender's A record.
    let [host] = answer.addresses[..] else {
        return None;
    };
    if !dialable(&host) {
        return None;
    }
    let http_port = txt(&answer, "http_port")
        .and_then(|value| std::str::from_utf8(value).ok()?.parse::<u16>().ok())
        .filter(|port| *port != 0);
    let bridge = DiscoveredBridge {
        name,
        host: host.to_string(),
        port: answer.port,
        http_port,
    };
    Some((bridge, host))
}

/// The value of a TXT key, which RFC 6763 section 6.4 matches case-insensitively.
fn txt<'a>(answer: &'a Answer, key: &str) -> Option<&'a [u8]> {
    answer
        .txt
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key.as_bytes()))
        .and_then(|(_, value)| value.as_deref())
}

fn dialable(address: &Ipv4Addr) -> bool {
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || address.is_broadcast())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(name: &str, address: [u8; 4]) -> Answer {
        Answer {
            instance: Some(name.as_bytes().to_vec()),
            port: 39000,
            ttl: 120,
            txt: vec![
                (b"txtvers".to_vec(), Some(b"1".to_vec())),
                (b"http_port".to_vec(), Some(b"8088".to_vec())),
            ],
            addresses: vec![Ipv4Addr::from(address)],
        }
    }

    fn bridge(name: &str, host: &str) -> DiscoveredBridge {
        DiscoveredBridge {
            name: name.to_owned(),
            host: host.to_owned(),
            port: 39000,
            http_port: Some(8088),
        }
    }

    #[test]
    fn implementation_matches_the_machine_readable_discovery_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../../../docs/bridge-discovery.json"))
                .expect("valid discovery contract");

        assert_eq!(contract["service_type"], format!("{SERVICE}.{PROTO}"));
        assert_eq!(contract["txtvers"], TXT_VERSION);
        assert_eq!(
            contract["txt_keys"],
            serde_json::json!(["txtvers", "http_port"])
        );
    }

    #[test]
    fn an_advertised_bridge_becomes_a_target_candidate() {
        assert_eq!(
            bridges([answer("StreamLine Bridge", [192, 0, 2, 20])]),
            [bridge("StreamLine Bridge", "192.0.2.20")]
        );
    }

    #[test]
    fn several_bridges_are_ordered_by_name_and_duplicates_collapse() {
        let found = bridges([
            answer("StreamLine Bridge-2", [192, 0, 2, 21]),
            answer("StreamLine Bridge", [192, 0, 2, 22]),
            // One responder answering twice, or a stale record beside a fresh one.
            answer("StreamLine Bridge", [192, 0, 2, 20]),
        ]);

        assert_eq!(
            found,
            [
                bridge("StreamLine Bridge", "192.0.2.20"),
                bridge("StreamLine Bridge-2", "192.0.2.21"),
            ]
        );
    }

    #[test]
    fn a_goodbye_or_an_unusable_answer_is_not_a_candidate() {
        let goodbye = Answer {
            ttl: 0,
            ..answer("Gone", [192, 0, 2, 20])
        };
        let no_port = Answer {
            port: 0,
            ..answer("No port", [192, 0, 2, 20])
        };
        let no_address = Answer {
            addresses: vec![],
            ..answer("No address", [192, 0, 2, 20])
        };
        let no_name = Answer {
            instance: None,
            ..answer("", [192, 0, 2, 20])
        };
        let invalid_name = Answer {
            instance: Some(vec![0xff, 0xfe]),
            ..answer("", [192, 0, 2, 20])
        };

        assert!(bridges([
            goodbye,
            no_port,
            no_address,
            no_name,
            invalid_name,
            answer("Line\nbreak", [192, 0, 2, 20]),
            answer("Loopback", [127, 0, 0, 1]),
            answer("Unspecified", [0, 0, 0, 0]),
            answer("Multicast", [224, 0, 0, 251]),
        ])
        .is_empty());
    }

    #[test]
    fn an_answer_with_a_second_address_is_not_trusted() {
        let forged = Answer {
            addresses: vec![Ipv4Addr::new(192, 0, 2, 66), Ipv4Addr::new(192, 0, 2, 20)],
            ..answer("StreamLine Bridge", [0, 0, 0, 0])
        };

        assert!(bridges([forged]).is_empty());
    }

    #[test]
    fn a_request_soon_after_a_browse_ends_reuses_its_bridges() {
        let clock = std::cell::Cell::new(Instant::now());
        let browse_for = |name: &'static str| {
            let clock = &clock;
            move || {
                clock.set(clock.get() + Duration::from_secs(3));
                Ok::<_, ()>(vec![answer(name, [192, 0, 2, 20])])
            }
        };
        let mut recent = RecentBrowse::default();

        let first = recent.bridges(|| clock.get(), browse_for("First"));
        clock.set(clock.get() + REUSE_WINDOW - Duration::from_millis(1));
        let queued = recent.bridges(|| clock.get(), browse_for("Queued"));
        clock.set(clock.get() + Duration::from_millis(1));
        let fresh = recent.bridges(|| clock.get(), browse_for("Fresh"));

        assert_eq!(first, Ok(vec![bridge("First", "192.0.2.20")]));
        assert_eq!(queued, first);
        assert_eq!(fresh, Ok(vec![bridge("Fresh", "192.0.2.20")]));
    }

    #[test]
    fn a_failed_browse_is_not_reused() {
        let start = Instant::now();
        let mut recent = RecentBrowse::default();

        assert_eq!(
            recent.bridges(|| start, || Err("mDNS stopped")),
            Err("mDNS stopped")
        );
        assert_eq!(
            recent.bridges(
                || start,
                || Ok::<_, &str>(vec![answer("Back", [192, 0, 2, 20])])
            ),
            Ok(vec![bridge("Back", "192.0.2.20")])
        );
    }

    #[test]
    fn only_the_known_txt_version_is_read() {
        let mut other_version = answer("Future", [192, 0, 2, 20]);
        other_version.txt[0].1 = Some(b"2".to_vec());
        let mut unversioned = answer("Unversioned", [192, 0, 2, 20]);
        unversioned.txt.remove(0);
        let mut shouting = answer("StreamLine Bridge", [192, 0, 2, 20]);
        shouting.txt = vec![
            (b"TXTVERS".to_vec(), Some(b"1".to_vec())),
            (b"HTTP_PORT".to_vec(), Some(b"8088".to_vec())),
        ];

        assert_eq!(
            bridges([other_version, unversioned, shouting]),
            [bridge("StreamLine Bridge", "192.0.2.20")]
        );
    }

    #[test]
    fn a_missing_or_malformed_console_port_leaves_only_the_target() {
        for value in [
            None,
            Some(b"".to_vec()),
            Some(b"0".to_vec()),
            Some(b"65536".to_vec()),
        ] {
            let mut advertised = answer("StreamLine Bridge", [192, 0, 2, 20]);
            advertised.txt[1].1 = value.clone();

            assert_eq!(
                bridges([advertised])[0].http_port,
                None,
                "http_port value {value:?}"
            );
        }
    }
}
