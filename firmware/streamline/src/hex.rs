//! Lowercase hex rendering for keys, digests, and wire dumps.

/// Render bytes as lowercase hex, two characters per byte.
pub fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn encodes_empty_input_as_empty_string() {
        assert_eq!(encode(&[]), "");
    }

    #[test]
    fn pads_each_byte_to_two_lowercase_digits() {
        assert_eq!(encode(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
    }

    #[test]
    fn renders_every_byte_value_in_order() {
        let all: Vec<u8> = (0..=u8::MAX).collect();
        let encoded = encode(&all);
        assert_eq!(encoded.len(), 512);
        assert!(encoded.starts_with("000102"));
        assert!(encoded.ends_with("fdfeff"));
        assert!(encoded
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    }
}
