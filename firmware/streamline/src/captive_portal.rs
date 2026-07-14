//! Host-testable captive-portal responses for the setup network.

use std::net::Ipv4Addr;

const HEADER_BYTES: usize = 12;
const MAX_NAME_BYTES: usize = 255;
const TYPE_A: u16 = 1;
const CLASS_IN: u16 = 1;
const ANSWER_BYTES: usize = 16;
const TTL_SECONDS: u32 = 60;

/// Return the canonical browser origin for the setup console.
pub fn console_url(address: Ipv4Addr) -> String {
    format!("http://{address}/")
}

/// Answer one standard DNS question without allocating.
///
/// IPv4 questions receive the setup AP address. Other types receive an empty
/// successful response so clients can continue with an IPv4 lookup. Malformed,
/// compressed, multi-question, and non-query packets are ignored.
pub fn dns_reply(query: &[u8], address: Ipv4Addr, response: &mut [u8]) -> Option<usize> {
    let flags = read_u16(query, 2)?;
    if flags & 0x8000 != 0 || flags & 0x7800 != 0 || read_u16(query, 4)? != 1 {
        return None;
    }

    let question = Question::parse(query)?;
    let has_answer = question.kind == TYPE_A && question.class == CLASS_IN;
    let response_len = question
        .end
        .checked_add(usize::from(has_answer) * ANSWER_BYTES)?;
    if response.len() < response_len {
        return None;
    }

    response[..2].copy_from_slice(&query[..2]);
    response[2..4].copy_from_slice(&(0x8400 | (flags & 0x0100)).to_be_bytes());
    response[4..6].copy_from_slice(&1_u16.to_be_bytes());
    response[6..8].copy_from_slice(&u16::from(has_answer).to_be_bytes());
    response[8..12].fill(0);
    response[HEADER_BYTES..question.end].copy_from_slice(&query[HEADER_BYTES..question.end]);

    if has_answer {
        let answer = &mut response[question.end..response_len];
        answer[..2].copy_from_slice(&[0xc0, 0x0c]);
        answer[2..4].copy_from_slice(&TYPE_A.to_be_bytes());
        answer[4..6].copy_from_slice(&CLASS_IN.to_be_bytes());
        answer[6..10].copy_from_slice(&TTL_SECONDS.to_be_bytes());
        answer[10..12].copy_from_slice(&4_u16.to_be_bytes());
        answer[12..16].copy_from_slice(&address.octets());
    }

    Some(response_len)
}

struct Question {
    end: usize,
    kind: u16,
    class: u16,
}

impl Question {
    fn parse(packet: &[u8]) -> Option<Self> {
        let mut cursor = HEADER_BYTES;
        loop {
            let label_len = usize::from(*packet.get(cursor)?);
            cursor = cursor.checked_add(1)?;
            if label_len == 0 {
                break;
            }
            // Compression pointers and extended label types have their high
            // bits set. Queries do not need them, so reject them rather than
            // following attacker-controlled offsets.
            if label_len > 63 {
                return None;
            }
            cursor = cursor.checked_add(label_len)?;
            packet.get(cursor.checked_sub(1)?)?;
            if cursor - HEADER_BYTES > MAX_NAME_BYTES {
                return None;
            }
        }
        if cursor - HEADER_BYTES > MAX_NAME_BYTES {
            return None;
        }

        let kind = read_u16(packet, cursor)?;
        let class = read_u16(packet, cursor.checked_add(2)?)?;
        Some(Self {
            end: cursor.checked_add(4)?,
            kind,
            class,
        })
    }
}

fn read_u16(packet: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_be_bytes([
        *packet.get(offset)?,
        *packet.get(offset.checked_add(1)?)?,
    ]))
}

#[cfg(test)]
mod tests {
    use super::{console_url, dns_reply};
    use std::net::Ipv4Addr;

    const SETUP_ADDRESS: Ipv4Addr = Ipv4Addr::new(192, 168, 71, 1);

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

    fn reply(query: &[u8]) -> Option<Vec<u8>> {
        let mut response = [0_u8; 512];
        let len = dns_reply(query, SETUP_ADDRESS, &mut response)?;
        Some(response[..len].to_vec())
    }

    #[test]
    fn console_url_uses_the_setup_address_as_the_origin() {
        assert_eq!(console_url(SETUP_ADDRESS), "http://192.168.71.1/");
    }

    #[test]
    fn ipv4_query_returns_the_setup_address() {
        let request = query(1);
        let response = reply(&request).expect("valid DNS query");

        assert_eq!(&response[..2], &[0x12, 0x34]);
        assert_eq!(&response[2..4], &[0x85, 0x00]);
        assert_eq!(&response[4..12], &[0, 1, 0, 1, 0, 0, 0, 0]);
        assert_eq!(&response[12..request.len()], &request[12..]);
        assert_eq!(
            &response[request.len()..],
            &[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 168, 71, 1]
        );
    }

    #[test]
    fn non_ipv4_query_gets_an_empty_successful_reply() {
        let request = query(28);
        let response = reply(&request).expect("valid DNS query");

        assert_eq!(&response[4..12], &[0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(response.len(), request.len());
    }

    #[test]
    fn additional_records_are_not_reflected() {
        let mut request = query(1);
        let question_end = request.len();
        request[11] = 1;
        request.extend_from_slice(&[0, 0, 41, 0x04, 0xd0, 0, 0, 0, 0, 0, 0]);

        let response = reply(&request).expect("valid DNS query");

        assert_eq!(response.len(), question_end + 16);
        assert_eq!(&response[10..12], &[0, 0]);
    }

    #[test]
    fn malformed_or_unsupported_packets_are_ignored() {
        assert!(reply(&[]).is_none());

        let mut response_packet = query(1);
        response_packet[2] = 0x81;
        assert!(reply(&response_packet).is_none());

        let mut nonstandard_opcode = query(1);
        nonstandard_opcode[2] = 0x09;
        assert!(reply(&nonstandard_opcode).is_none());

        let mut multiple_questions = query(1);
        multiple_questions[5] = 2;
        assert!(reply(&multiple_questions).is_none());

        let mut compressed_question = query(1);
        compressed_question[12] = 0xc0;
        assert!(reply(&compressed_question).is_none());

        let mut truncated_label = query(1);
        truncated_label.truncate(15);
        assert!(reply(&truncated_label).is_none());
    }

    #[test]
    fn oversized_names_and_small_response_buffers_are_rejected() {
        let mut oversized = vec![0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
        for _ in 0..4 {
            oversized.push(63);
            oversized.extend_from_slice(&[b'a'; 63]);
        }
        oversized.extend_from_slice(&[0, 0, 1, 0, 1]);
        assert!(reply(&oversized).is_none());

        let mut too_small = [0_u8; 8];
        assert!(dns_reply(&query(1), SETUP_ADDRESS, &mut too_small).is_none());
    }
}
