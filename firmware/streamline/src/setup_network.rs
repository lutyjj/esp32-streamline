//! The per-device setup network credential.
//!
//! The setup access point runs WPA2 with a password generated on the device
//! and kept in NVS, so joining it proves possession of the board or its
//! label — the trust anchor commissioning needs. This module owns the
//! password's shape; the hardware RNG and NVS storage stay in adapters.

use crate::random::RandomBytes;

/// Password characters: lowercase letters and digits minus the confusable
/// `l`, `o`, `0`, and `1`, so a label or serial readout types unambiguously.
/// Exactly 32 symbols, so a byte modulo the length carries no bias.
const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
const GROUPS: usize = 4;
const GROUP_LEN: usize = 4;

const _: () = assert!(ALPHABET.len() == 32);

/// The setup network's SSID and WPA2 password, as the API reports them and
/// the access point serves them.
#[derive(Clone)]
pub struct SetupNetwork {
    pub ssid: String,
    pub password: String,
}

/// Mint a password: four dash-separated groups of four symbols, 80 bits of
/// hardware randomness in a shape a phone keyboard and a case label handle.
pub fn generate_password(random: &mut impl RandomBytes) -> String {
    let mut entropy = [0_u8; GROUPS * GROUP_LEN];
    random.fill(&mut entropy);
    let mut password = String::with_capacity(entropy.len() + GROUPS - 1);
    for (index, byte) in entropy.iter().enumerate() {
        if index > 0 && index % GROUP_LEN == 0 {
            password.push('-');
        }
        password.push(ALPHABET[usize::from(*byte) % ALPHABET.len()] as char);
    }
    password
}

/// Whether a stored value has the generated shape. A corrupt or foreign
/// value fails, and the boot path mints a fresh password instead of starting
/// an access point with an untrusted secret.
pub fn is_valid_password(candidate: &str) -> bool {
    let groups: Vec<&str> = candidate.split('-').collect();
    groups.len() == GROUPS
        && groups.iter().all(|group| {
            group.len() == GROUP_LEN && group.bytes().all(|byte| ALPHABET.contains(&byte))
        })
}

#[cfg(test)]
mod tests {
    use super::{generate_password, is_valid_password};
    use crate::random::RandomBytes;

    /// Yields a scripted byte sequence, repeating the last byte when exhausted.
    struct Scripted(Vec<u8>);

    impl RandomBytes for Scripted {
        fn fill(&mut self, output: &mut [u8]) {
            for (index, slot) in output.iter_mut().enumerate() {
                *slot = *self.0.get(index).unwrap_or(&0);
            }
        }
    }

    #[test]
    fn passwords_have_the_grouped_shape_and_validate() {
        let password = generate_password(&mut Scripted((0..16).collect()));
        assert_eq!(password, "abcd-efgh-ijkm-npqr");
        assert!(is_valid_password(&password));
    }

    #[test]
    fn passwords_satisfy_wpa2_length_bounds() {
        let password = generate_password(&mut Scripted(vec![255; 16]));
        // WPA2-Personal passphrases must be 8..=63 characters.
        assert!((8..=63).contains(&password.len()));
    }

    #[test]
    fn every_byte_maps_into_the_unambiguous_alphabet() {
        let password = generate_password(&mut Scripted((0..=255).step_by(16).collect()));
        for symbol in password.chars().filter(|&c| c != '-') {
            assert!(super::ALPHABET.contains(&(symbol as u8)), "symbol {symbol}");
            assert!(!"lo01".contains(symbol), "confusable symbol {symbol}");
        }
    }

    #[test]
    fn foreign_or_corrupt_values_fail_validation() {
        for candidate in [
            "",
            "abcd-efgh-ijkm",         // too few groups
            "abcd-efgh-ijkm-npq",     // short group
            "abcd-efgh-ijkm-npq1",    // confusable digit
            "ABCD-EFGH-IJKM-NPQR",    // uppercase
            "abcd efgh ijkm npqr",    // wrong separator
            "abcd-efgh-ijkm-npqr-st", // too many groups
        ] {
            assert!(!is_valid_password(candidate), "{candidate}");
        }
    }
}
