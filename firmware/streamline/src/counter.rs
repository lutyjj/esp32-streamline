//! Lock-free counters for targets with 32-bit atomics.

use core::sync::atomic::{AtomicU32, Ordering};

#[derive(Default)]
pub(crate) struct Counter64 {
    version: AtomicU32,
    low: AtomicU32,
    high: AtomicU32,
}

impl Counter64 {
    pub(crate) fn add(&self, value: u32) {
        loop {
            let version = self.version.load(Ordering::Acquire);
            if version % 2 != 0 {
                core::hint::spin_loop();
                continue;
            }
            if self
                .version
                .compare_exchange_weak(
                    version,
                    version.wrapping_add(1),
                    Ordering::Acquire,
                    Ordering::Relaxed,
                )
                .is_err()
            {
                continue;
            }

            let current = (u64::from(self.high.load(Ordering::Relaxed)) << 32)
                | u64::from(self.low.load(Ordering::Relaxed));
            let next = current.wrapping_add(u64::from(value));
            self.low.store(next as u32, Ordering::Relaxed);
            self.high.store((next >> 32) as u32, Ordering::Relaxed);
            self.version
                .store(version.wrapping_add(2), Ordering::Release);
            return;
        }
    }

    pub(crate) fn load(&self) -> u64 {
        loop {
            let start = self.version.load(Ordering::Acquire);
            if start % 2 != 0 {
                core::hint::spin_loop();
                continue;
            }
            let low = self.low.load(Ordering::Relaxed);
            let high = self.high.load(Ordering::Relaxed);
            let end = self.version.load(Ordering::Acquire);
            if start == end {
                return (u64::from(high) << 32) | u64::from(low);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Counter64;

    #[test]
    fn starts_at_zero() {
        assert_eq!(Counter64::default().load(), 0);
    }

    #[test]
    fn carries_across_the_32_bit_boundary() {
        let counter = Counter64::default();

        counter.add(u32::MAX);
        counter.add(10);

        assert_eq!(counter.load(), 4_294_967_305);
    }
}
