//! Byte-exact encoding of the StreamLine TCP PCM header.

pub const MAGIC: [u8; 4] = *b"ELI1";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 24;
pub const SAMPLE_RATE_HZ: u32 = 48_000;
pub const CHANNELS: u8 = 2;
pub const BITS_PER_SAMPLE: u8 = 16;
pub const FRAMES_PER_PACKET: u32 = 256;
pub const BYTES_PER_FRAME: usize = 4;
pub const PAYLOAD_BYTES: usize = FRAMES_PER_PACKET as usize * BYTES_PER_FRAME;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PacketHeader {
    pub sequence: u32,
}

impl PacketHeader {
    pub const fn new(sequence: u32) -> Self {
        Self { sequence }
    }

    pub fn encode(self) -> [u8; HEADER_LEN] {
        let mut bytes = [0; HEADER_LEN];
        bytes[0..4].copy_from_slice(&MAGIC);
        bytes[4] = VERSION;
        bytes[5] = HEADER_LEN as u8;
        bytes[6] = CHANNELS;
        bytes[7] = BITS_PER_SAMPLE;
        bytes[8..12].copy_from_slice(&self.sequence.to_le_bytes());
        bytes[12..16].copy_from_slice(&SAMPLE_RATE_HZ.to_le_bytes());
        bytes[16..20].copy_from_slice(&FRAMES_PER_PACKET.to_le_bytes());
        bytes[20..24].copy_from_slice(&(PAYLOAD_BYTES as u32).to_le_bytes());
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::{PacketHeader, HEADER_LEN};

    #[test]
    fn encodes_the_bridge_protocol_in_little_endian() {
        let header = PacketHeader::new(0x4433_2211).encode();

        assert_eq!(header.len(), HEADER_LEN);
        assert_eq!(
            header,
            [
                b'E', b'L', b'I', b'1', 1, 24, 2, 16, 0x11, 0x22, 0x33, 0x44, 0x80, 0xbb, 0, 0, 0,
                1, 0, 0, 0, 4, 0, 0,
            ]
        );
    }
}
