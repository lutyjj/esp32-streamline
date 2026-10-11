//! Shared settings limits and credential shape validation.

/// Longest friendly device name, in characters. Fits an NVS string entry and
/// a browser tab title.
pub const MAX_DEVICE_NAME_CHARS: usize = 32;
/// Admin keys are generated, never composed by hand: exactly 24 random bytes
/// rendered as lowercase hexadecimal. One exact shape keeps runtime
/// validation, the OpenAPI schema, and every client in agreement.
pub const ADMIN_KEY_HEX_CHARS: usize = 48;
/// The canonical admin-key shape as the OpenAPI schema declares it.
pub const ADMIN_KEY_PATTERN: &str = "^[0-9a-f]{48}$";
/// Whether an admin key is in the canonical generated form.
pub fn is_canonical_admin_key(secret: &str) -> bool {
    secret.len() == ADMIN_KEY_HEX_CHARS
        && secret
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
