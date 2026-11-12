//! Fixed-capacity audio packets passed between the real-time tasks.

use crate::protocol::{PacketHeader, HEADER_LEN, PAYLOAD_BYTES};

pub const MAX_PACKET_BYTES: usize = HEADER_LEN + PAYLOAD_BYTES;

/// One capture interval: a header and full PCM, or a header-only silence record.
pub struct AudioPacket {
    bytes: [u8; MAX_PACKET_BYTES],
    pub trace: Option<Box<crate::telemetry::PacketTrace>>,
}

impl AudioPacket {
    pub fn from_pcm(sequence: u32, pcm: &[u8; PAYLOAD_BYTES]) -> Self {
        let mut bytes = [0; MAX_PACKET_BYTES];
        bytes[..HEADER_LEN].copy_from_slice(&PacketHeader::new(sequence).encode());
        bytes[HEADER_LEN..].copy_from_slice(pcm);
        Self { bytes, trace: None }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..HEADER_LEN + self.payload_bytes()]
    }

    pub fn append_wire(&self, output: &mut Vec<u8>) {
        let carrier = self.trace.as_ref().map(|trace| trace.traceparent());
        let traceparent = carrier
            .as_ref()
            .and_then(|value| value.as_bytes().try_into().ok());
        crate::protocol::append_header(
            self.bytes[..HEADER_LEN].try_into().expect("fixed header"),
            traceparent,
            output,
        );
        output.extend_from_slice(&self.as_bytes()[HEADER_LEN..]);
    }

    pub fn silence(sequence: u32) -> Self {
        let mut bytes = [0; MAX_PACKET_BYTES];
        bytes[..HEADER_LEN].copy_from_slice(&PacketHeader::silence(sequence).encode());
        Self { bytes, trace: None }
    }

    pub fn payload_bytes(&self) -> usize {
        u32::from_le_bytes(self.bytes[20..24].try_into().expect("payload length")) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioPacket, MAX_PACKET_BYTES, PAYLOAD_BYTES};

    #[test]
    fn packet_coalesces_header_and_pcm() {
        let mut pcm = [0_u8; PAYLOAD_BYTES];
        pcm[..4].copy_from_slice(&[0x11, 0x22, 0x33, 0x44]);
        let packet = AudioPacket::from_pcm(4, &pcm);
        assert_eq!(packet.as_bytes().len(), MAX_PACKET_BYTES);
        assert_eq!(&packet.as_bytes()[24..28], &pcm[..4]);
        assert_eq!(MAX_PACKET_BYTES, 1048);
    }

    #[test]
    fn silence_has_no_pcm_payload_but_retains_its_capture_sequence() {
        let packet = AudioPacket::silence(u32::MAX);
        assert_eq!(packet.as_bytes().len(), 24);
        assert_eq!(packet.payload_bytes(), 0);
        assert_eq!(&packet.as_bytes()[8..12], &[255; 4]);
        assert_eq!(&packet.as_bytes()[16..20], &256u32.to_le_bytes());
    }
}
