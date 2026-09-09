//! Fixed-capacity, drop-oldest packet queue between the capture and network tasks.

use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::Duration,
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

    /// Wait up to `timeout` for a packet, returning it and the remaining
    /// depth, or `None` when the queue stayed empty. The bound keeps the
    /// consumer responsive to control requests (a transport quiesce) that
    /// arrive while no audio flows.
    pub fn pop_timeout(&self, timeout: Duration) -> Option<(T, usize)> {
        let mut packets = self.packets.lock().expect("packet queue poisoned");
        loop {
            if let Some(packet) = packets.pop_front() {
                return Some((packet, packets.len()));
            }
            let (guard, waited) = self
                .ready
                .wait_timeout(packets, timeout)
                .expect("packet queue poisoned");
            packets = guard;
            if waited.timed_out() {
                let packet = packets.pop_front()?;
                return Some((packet, packets.len()));
            }
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
    use std::time::Duration;

    use super::{PacketQueue, QUEUE_DEPTH};

    fn pop(queue: &PacketQueue<u32>) -> Option<(u32, usize)> {
        queue.pop_timeout(Duration::ZERO)
    }

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
        assert_eq!(pop(&queue), Some((5, QUEUE_DEPTH - 1)));
    }

    #[test]
    fn pop_drains_in_order_and_reports_the_remaining_depth() {
        let queue = PacketQueue::new();
        queue.push_drop_oldest(10);
        queue.push_drop_oldest(20);
        assert_eq!(pop(&queue), Some((10, 1)));
        assert_eq!(pop(&queue), Some((20, 0)));
    }

    #[test]
    fn an_empty_queue_times_out_with_no_packet() {
        let queue = PacketQueue::<u32>::new();
        assert_eq!(queue.pop_timeout(Duration::from_millis(1)), None);
    }
}
