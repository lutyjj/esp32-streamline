//! The randomness seam every secret-minting module draws from.
//!
//! The device implements it over the hardware RNG in
//! `adapters/random.rs`; host tests script it.

pub trait RandomBytes {
    fn fill(&mut self, output: &mut [u8]);
}
