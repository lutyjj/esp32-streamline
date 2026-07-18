//! Cross-language PCM frame conformance corpus.
//!
//! `docs/pcm-frame-vectors.json` is the single source of truth that proves the
//! Rust encoder in [`crate::protocol`] and the Python bridge parser agree on the
//! wire, byte for byte. This module builds the corpus from the live encoder and
//! its documented mutations. `make firmware-pcm-frame-vectors` writes the file,
//! `firmware-test` proves the committed file still matches the encoder, and
//! `bridge-test` proves the parser accepts every valid frame and rejects every
//! invalid one.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};

use crate::protocol::{
    PacketHeader, BITS_PER_SAMPLE, BYTES_PER_FRAME, CHANNELS, FRAMES_PER_PACKET, HEADER_LEN, MAGIC,
    PAYLOAD_BYTES, SAMPLE_RATE_HZ, VERSION,
};

/// Wire constants both implementations must share.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Constants {
    pub magic: String,
    pub version: u8,
    pub header_len: u8,
    pub sample_rate: u32,
    pub channels: u8,
    pub bits_per_sample: u8,
    pub bytes_per_frame: u8,
    pub frames_per_packet: u32,
    pub payload_bytes: u32,
}

/// A frame the encoder can emit. The parser must decode it to `sequence`,
/// `frames`, and `payload_bytes` with the deployed single-format contract.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ValidFrame {
    pub name: String,
    pub sequence: u32,
    pub frames: u32,
    pub payload_bytes: u32,
    pub frame_hex: String,
}

/// A frame the deployed parser must reject. The encoder cannot build any of
/// these: its packet type only represents full 256-frame packets, so every
/// rejection is receiver-side.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct InvalidFrame {
    pub name: String,
    pub reason: String,
    pub frame_hex: String,
}

/// The full conformance corpus.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Vectors {
    pub constants: Constants,
    pub valid: Vec<ValidFrame>,
    pub invalid: Vec<InvalidFrame>,
}

/// Build the corpus from the live encoder and its documented mutations.
pub fn vectors() -> Vectors {
    Vectors {
        constants: constants(),
        valid: valid_frames(),
        invalid: invalid_frames(),
    }
}

fn constants() -> Constants {
    Constants {
        magic: String::from_utf8(MAGIC.to_vec()).expect("magic is ASCII"),
        version: VERSION,
        header_len: HEADER_LEN as u8,
        sample_rate: SAMPLE_RATE_HZ,
        channels: CHANNELS,
        bits_per_sample: BITS_PER_SAMPLE,
        bytes_per_frame: BYTES_PER_FRAME as u8,
        frames_per_packet: FRAMES_PER_PACKET,
        payload_bytes: PAYLOAD_BYTES as u32,
    }
}

/// Frames the encoder emits: full 256-frame packets across the sequence
/// range. The capture engine coalesces short hardware reads before framing,
/// so full packets are the encoder's entire output vocabulary.
fn valid_frames() -> Vec<ValidFrame> {
    [
        ("full_frame", 1),
        ("sequence_little_endian", 0x4433_2211),
        ("sequence_zero", 0),
        ("sequence_wrap_max", u32::MAX),
    ]
    .into_iter()
    .map(|(name, sequence)| valid_frame(name, sequence))
    .collect()
}

fn valid_frame(name: &str, sequence: u32) -> ValidFrame {
    let mut frame = PacketHeader::new(sequence).encode().to_vec();
    frame.extend(payload(PAYLOAD_BYTES));
    ValidFrame {
        name: name.to_owned(),
        sequence,
        frames: FRAMES_PER_PACKET,
        payload_bytes: PAYLOAD_BYTES as u32,
        frame_hex: hex(&frame),
    }
}

/// Malformed frames the deployed single-format parser must reject, one per
/// documented failure category.
fn invalid_frames() -> Vec<InvalidFrame> {
    vec![
        corrupt("bad_magic", "magic", |frame| frame[0] = b'X'),
        corrupt("bad_version", "version", |frame| frame[4] = VERSION + 1),
        corrupt("bad_header_len", "header_len", |frame| {
            frame[5] = HEADER_LEN as u8 - 1
        }),
        corrupt("short_packet", "header_len", |frame| {
            frame.truncate(HEADER_LEN - 1)
        }),
        corrupt("wrong_sample_rate", "format", |frame| {
            frame[12..16].copy_from_slice(&44_100u32.to_le_bytes())
        }),
        corrupt("wrong_channels", "format", |frame| frame[6] = CHANNELS + 1),
        corrupt("wrong_bits", "format", |frame| {
            frame[7] = BITS_PER_SAMPLE + 8
        }),
        corrupt("wrong_frame_count", "frame", |frame| {
            frame[16..20].copy_from_slice(&(FRAMES_PER_PACKET * 2).to_le_bytes())
        }),
        short_frame("short_single_frame", 1),
        short_frame("short_three_frames", 3),
        bad_payload_size("payload_zero", 0),
        bad_payload_size("payload_unaligned", PAYLOAD_BYTES - 1),
        bad_payload_size("payload_oversize", PAYLOAD_BYTES + BYTES_PER_FRAME),
        corrupt("payload_length_mismatch", "payload", |frame| {
            frame.truncate(HEADER_LEN + PAYLOAD_BYTES - 1)
        }),
    ]
}

/// An internally consistent packet carrying fewer than 256 frames. The wire
/// contract is fixed-size, so the parser rejects the frame count itself.
fn short_frame(name: &str, frames: u32) -> InvalidFrame {
    let payload_bytes = frames as usize * BYTES_PER_FRAME;
    let mut frame = PacketHeader::new(2).encode().to_vec();
    frame[16..20].copy_from_slice(&frames.to_le_bytes());
    frame[20..24].copy_from_slice(&(payload_bytes as u32).to_le_bytes());
    frame.truncate(HEADER_LEN);
    frame.extend(payload(payload_bytes));
    InvalidFrame {
        name: name.to_owned(),
        reason: "frame".to_owned(),
        frame_hex: hex(&frame),
    }
}

/// A valid full frame with one field corrupted to model a receiver-visible
/// failure only the parser detects.
fn corrupt(name: &str, reason: &str, edit: impl Fn(&mut Vec<u8>)) -> InvalidFrame {
    let mut frame = PacketHeader::new(2).encode().to_vec();
    frame.extend(payload(PAYLOAD_BYTES));
    edit(&mut frame);
    InvalidFrame {
        name: name.to_owned(),
        reason: reason.to_owned(),
        frame_hex: hex(&frame),
    }
}

/// A frame declaring a payload size other than the fixed packet size. The
/// actual payload matches the declared size, so the parser rejects the size
/// itself, not a length mismatch.
fn bad_payload_size(name: &str, payload_bytes: usize) -> InvalidFrame {
    let mut frame = PacketHeader::new(2).encode().to_vec();
    frame.extend(payload(payload_bytes));
    frame[20..24].copy_from_slice(&(payload_bytes as u32).to_le_bytes());
    InvalidFrame {
        name: name.to_owned(),
        reason: "payload".to_owned(),
        frame_hex: hex(&frame),
    }
}

/// Deterministic filler so a regenerated corpus is byte-stable.
fn payload(len: usize) -> impl Iterator<Item = u8> {
    (0..len).map(|i| i as u8)
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{vectors, Vectors};
    use crate::protocol::{FRAMES_PER_PACKET, PAYLOAD_BYTES};

    #[test]
    fn committed_vectors_match_the_encoder() {
        let committed: Vectors =
            serde_json::from_str(include_str!("../../../docs/pcm-frame-vectors.json"))
                .expect("docs/pcm-frame-vectors.json parses");
        assert_eq!(
            committed,
            vectors(),
            "docs/pcm-frame-vectors.json is stale — run `make firmware-pcm-frame-vectors`",
        );
    }

    #[test]
    fn every_valid_vector_carries_one_full_packet() {
        for frame in vectors().valid {
            assert_eq!(frame.frames, FRAMES_PER_PACKET, "{}", frame.name);
            assert_eq!(frame.payload_bytes, PAYLOAD_BYTES as u32, "{}", frame.name);
        }
    }
}
