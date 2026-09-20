//! Fixed-capacity audio packets passed between the real-time tasks.

use crate::protocol::{PacketHeader, HEADER_LEN, PAYLOAD_BYTES};

pub const MAX_PACKET_BYTES: usize = HEADER_LEN + PAYLOAD_BYTES;

/// One complete wire packet: header plus exactly [`PAYLOAD_BYTES`] of PCM.
/// The capture engine coalesces short hardware reads before building one, so
/// a partially filled packet cannot exist.
#[derive(Clone)]
pub struct AudioPacket {
    bytes: [u8; MAX_PACKET_BYTES],
}

impl AudioPacket {
    pub fn from_pcm(sequence: u32, pcm: &[u8; PAYLOAD_BYTES]) -> Self {
        let mut bytes = [0; MAX_PACKET_BYTES];
        bytes[..HEADER_LEN].copy_from_slice(&PacketHeader::new(sequence).encode());
        bytes[HEADER_LEN..].copy_from_slice(pcm);
        Self { bytes }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub const fn payload_bytes(&self) -> usize {
        PAYLOAD_BYTES
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
        assert_eq!(packet.payload_bytes(), PAYLOAD_BYTES);
        assert_eq!(MAX_PACKET_BYTES, 1048);
    }
}
