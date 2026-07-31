//! Hardware randomness behind the [`RandomBytes`] seam.

use crate::random::RandomBytes;

/// ESP-IDF's hardware RNG. With the radio running `esp_fill_random` yields
/// true random numbers; before it starts (the boot-time setup-network mint)
/// the RNG runs on the entropy the second-stage bootloader seeded it with.
pub struct EspRandom;

impl RandomBytes for EspRandom {
    fn fill(&mut self, output: &mut [u8]) {
        unsafe { esp_idf_svc::sys::esp_fill_random(output.as_mut_ptr().cast(), output.len()) };
    }
}
