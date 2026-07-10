//! Captive-portal DNS replies for the setup network.

use std::net::Ipv4Addr;

const HEADER_LEN: usize = 12;
const DNS_TYPE_A: u16 = 1;
const DNS_CLASS_IN: u16 = 1;
const DNS_TTL_SECONDS: u32 = 60;

/// Setup AP IPv4 address documented in the commissioning flow.
pub const SETUP_ADDRESS: Ipv4Addr = Ipv4Addr::new(192, 168, 71, 1);

/// Formats the setup console address for DHCP Option 114.
pub fn console_url(address: Ipv4Addr) -> String {
    format!("http://{address}/")
}

/// Builds a DNS reply that directs an IPv4 lookup to the setup console.
///
/// The setup resolver is authoritative only for the one-question DNS packets
/// that captive-portal clients send. IPv6 lookups receive an empty successful
/// reply because the setup network has no IPv6 address to advertise.
pub fn dns_response(query: &[u8], address: Ipv4Addr) -> Option<Vec<u8>> {
    let question = Question::parse(query)?;
    let answers = u16::from(question.kind == DNS_TYPE_A && question.class == DNS_CLASS_IN);
    let request_flags = u16::from_be_bytes(query[2..4].try_into().ok()?);
    if request_flags & 0x8000 != 0 {
        return None;
    }

    let mut response = Vec::with_capacity(question.end + usize::from(answers) * 16);
    response.extend_from_slice(&query[..2]);
    let flags = 0x8400 | (request_flags & 0x0100);
    response.extend_from_slice(&flags.to_be_bytes());
    response.extend_from_slice(&1_u16.to_be_bytes());
    response.extend_from_slice(&answers.to_be_bytes());
    response.extend_from_slice(&0_u16.to_be_bytes());
    response.extend_from_slice(&0_u16.to_be_bytes());
    response.extend_from_slice(&query[HEADER_LEN..question.end]);

    if answers == 1 {
        response.extend_from_slice(&[0xc0, 0x0c]);
        response.extend_from_slice(&DNS_TYPE_A.to_be_bytes());
        response.extend_from_slice(&DNS_CLASS_IN.to_be_bytes());
        response.extend_from_slice(&DNS_TTL_SECONDS.to_be_bytes());
        response.extend_from_slice(&4_u16.to_be_bytes());
        response.extend_from_slice(&address.octets());
    }
    Some(response)
}

struct Question {
    end: usize,
    kind: u16,
    class: u16,
}

impl Question {
    fn parse(packet: &[u8]) -> Option<Self> {
        if packet.len() < HEADER_LEN || u16::from_be_bytes(packet[4..6].try_into().ok()?) != 1 {
            return None;
        }
        let mut cursor = HEADER_LEN;
        loop {
            let label_len = *packet.get(cursor)? as usize;
            cursor += 1;
            if label_len == 0 {
                break;
            }
            if label_len > 63 {
                return None;
            }
            cursor = cursor.checked_add(label_len)?;
            packet.get(cursor.checked_sub(1)?)?;
        }
        let kind = u16::from_be_bytes(packet.get(cursor..cursor + 2)?.try_into().ok()?);
        let class = u16::from_be_bytes(packet.get(cursor + 2..cursor + 4)?.try_into().ok()?);
        Some(Self {
            end: cursor + 4,
            kind,
            class,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{console_url, dns_response};

    use super::SETUP_ADDRESS;

    fn query(kind: u16) -> Vec<u8> {
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        query.extend_from_slice(&[
            3, b'w', b'w', b'w', 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e', 3, b'c', b'o', b'm',
            0,
        ]);
        query.extend_from_slice(&kind.to_be_bytes());
        query.extend_from_slice(&1_u16.to_be_bytes());
        query
    }

    #[test]
    fn console_url_uses_the_setup_address() {
        assert_eq!(console_url(SETUP_ADDRESS), "http://192.168.71.1/");
    }

    #[test]
    fn a_query_returns_the_setup_address() {
        let request = query(1);
        let response = dns_response(&request, SETUP_ADDRESS).expect("valid DNS query");

        assert_eq!(&response[..2], &[0x12, 0x34]);
        assert_eq!(&response[2..4], &[0x85, 0x00]);
        assert_eq!(&response[4..8], &[0, 1, 0, 1]);
        assert_eq!(&response[12..request.len()], &request[12..]);
        assert_eq!(
            &response[request.len()..],
            &[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 168, 71, 1]
        );
    }

    #[test]
    fn ipv6_query_gets_an_empty_successful_reply() {
        let request = query(28);
        let response = dns_response(&request, SETUP_ADDRESS).expect("valid DNS query");

        assert_eq!(&response[4..8], &[0, 1, 0, 0]);
        assert_eq!(response.len(), request.len());
    }

    #[test]
    fn malformed_or_response_packets_are_ignored() {
        assert!(dns_response(&[], SETUP_ADDRESS).is_none());
        let mut response = query(1);
        response[2] = 0x81;
        assert!(dns_response(&response, SETUP_ADDRESS).is_none());
    }
}
