//! Fixed-capacity, drop-oldest packet queue between the capture and network tasks.

use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
};

/// Packets buffered between capture and the network task. At 256 frames per
/// packet (~5.3 ms) this bounds the queue's added latency to ~170 ms.
pub const QUEUE_DEPTH: usize = 32;

pub struct PacketQueue<T> {
    packets: Mutex<VecDeque<T>>,
    ready: Condvar,
}

impl<T> PacketQueue<T> {
    pub fn new() -> Self {
        Self {
            packets: Mutex::new(VecDeque::with_capacity(QUEUE_DEPTH)),
            ready: Condvar::new(),
        }
    }

    /// Capture never blocks behind a slow receiver. At capacity discard the
    /// oldest packet, keeping latency bounded and the newest signal available.
    /// Returns whether a packet was dropped and the resulting depth.
    pub fn push_drop_oldest(&self, packet: T) -> (bool, usize) {
        let mut packets = self.packets.lock().expect("packet queue poisoned");
        let dropped = if packets.len() == QUEUE_DEPTH {
            packets.pop_front();
            true
        } else {
            false
        };
        packets.push_back(packet);
        let depth = packets.len();
        drop(packets);
        self.ready.notify_one();
        (dropped, depth)
    }

    /// Block until a packet is available, then return it and the remaining depth.
    pub fn pop(&self) -> (T, usize) {
        let mut packets = self.packets.lock().expect("packet queue poisoned");
        loop {
            if let Some(packet) = packets.pop_front() {
                return (packet, packets.len());
            }
            packets = self.ready.wait(packets).expect("packet queue poisoned");
        }
    }
}

impl<T> Default for PacketQueue<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{PacketQueue, QUEUE_DEPTH};

    #[test]
    fn push_drop_oldest_bounds_depth_and_keeps_the_newest_packets() {
        let queue = PacketQueue::new();
        for value in 0..QUEUE_DEPTH as u32 {
            // Filling to capacity never drops; depth tracks the count exactly.
            assert_eq!(queue.push_drop_oldest(value), (false, value as usize + 1));
        }
        // Past capacity every push drops the oldest and depth stays pinned, so
        // capture is never blocked and latency cannot grow.
        for value in QUEUE_DEPTH as u32..QUEUE_DEPTH as u32 + 5 {
            assert_eq!(queue.push_drop_oldest(value), (true, QUEUE_DEPTH));
        }
        // The retained window is the newest QUEUE_DEPTH values, oldest first.
        let (front, depth) = queue.pop();
        assert_eq!(front, 5);
        assert_eq!(depth, QUEUE_DEPTH - 1);
    }

    #[test]
    fn pop_drains_in_order_and_reports_the_remaining_depth() {
        let queue = PacketQueue::new();
        queue.push_drop_oldest(10);
        queue.push_drop_oldest(20);
        assert_eq!(queue.pop(), (10, 1));
        assert_eq!(queue.pop(), (20, 0));
    }
}
