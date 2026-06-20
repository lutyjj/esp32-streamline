//! Fixed-capacity audio packets passed between the real-time tasks.

use crate::protocol::{PacketHeader, HEADER_LEN, PAYLOAD_BYTES};

pub const MAX_PACKET_BYTES: usize = HEADER_LEN + PAYLOAD_BYTES;

#[derive(Clone)]
pub struct AudioPacket {
    bytes: [u8; MAX_PACKET_BYTES],
    len: usize,
}

impl AudioPacket {
    pub fn from_pcm(sequence: u32, pcm: &[u8]) -> Option<Self> {
        let header = PacketHeader::for_payload(sequence, pcm.len())?.encode();
        let mut bytes = [0; MAX_PACKET_BYTES];
        bytes[..HEADER_LEN].copy_from_slice(&header);
        bytes[HEADER_LEN..HEADER_LEN + pcm.len()].copy_from_slice(pcm);
        Some(Self {
            bytes,
            len: HEADER_LEN + pcm.len(),
        })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }

    pub const fn payload_bytes(&self) -> usize {
        self.len - HEADER_LEN
    }
}

#[cfg(test)]
mod tests {
    use super::{AudioPacket, MAX_PACKET_BYTES};

    #[test]
    fn packet_coalesces_header_and_pcm() {
        let pcm = [0x11, 0x22, 0x33, 0x44];
        let packet = AudioPacket::from_pcm(4, &pcm).expect("valid stereo frame");
        assert_eq!(packet.as_bytes().len(), 28);
        assert_eq!(&packet.as_bytes()[24..], &pcm);
        assert_eq!(packet.payload_bytes(), pcm.len());
        assert_eq!(MAX_PACKET_BYTES, 1048);
    }
}
