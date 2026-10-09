//! Fixed-capacity, drop-oldest packet queue between the capture and network tasks.

use std::{
    collections::VecDeque,
    sync::{Condvar, Mutex},
    time::Duration,
};

/// Packets buffered between capture and the network task. At 256 frames per
/// packet (~5.3 ms), 48 packets retain 256 ms of audio across a send stall.
pub const QUEUE_DEPTH: usize = 48;

// Keep each allocation small enough to coexist with transient HTTPS buffers.
// No packet admission or removal allocates after construction.
const CHUNK_DEPTH: usize = 8;
const CHUNK_COUNT: usize = QUEUE_DEPTH / CHUNK_DEPTH;
const _: () = assert!(QUEUE_DEPTH % CHUNK_DEPTH == 0);

struct PacketStorage<T> {
    chunks: [VecDeque<T>; CHUNK_COUNT],
    head: usize,
    len: usize,
}

impl<T> PacketStorage<T> {
    fn new() -> Self {
        Self {
            chunks: std::array::from_fn(|_| VecDeque::with_capacity(CHUNK_DEPTH)),
            head: 0,
            len: 0,
        }
    }

    fn pop_front(&mut self) -> Option<T> {
        if self.len == 0 {
            return None;
        }
        let packet = self.chunks[self.head / CHUNK_DEPTH].pop_front();
        self.head = (self.head + 1) % QUEUE_DEPTH;
        self.len -= 1;
        packet
    }

    fn push_back(&mut self, packet: T) {
        let tail = (self.head + self.len) % QUEUE_DEPTH;
        self.chunks[tail / CHUNK_DEPTH].push_back(packet);
        self.len += 1;
    }
}

pub struct PacketQueue<T> {
    packets: Mutex<Option<PacketStorage<T>>>,
    ready: Condvar,
}

impl<T> PacketQueue<T> {
    pub fn new() -> Self {
        Self {
            packets: Mutex::new(Some(PacketStorage::new())),
            ready: Condvar::new(),
        }
    }

    /// Capture never blocks behind a slow receiver. At capacity discard the
    /// oldest packet, keeping latency bounded and the newest signal available.
    /// Returns whether a packet was dropped and the resulting depth.
    pub fn push_drop_oldest(&self, packet: T) -> (bool, usize) {
        let mut state = self.packets.lock().expect("packet queue poisoned");
        let Some(packets) = state.as_mut() else {
            return (false, 0);
        };
        let dropped = if packets.len == QUEUE_DEPTH {
            packets.pop_front();
            true
        } else {
            false
        };
        packets.push_back(packet);
        let depth = packets.len;
        drop(state);
        self.ready.notify_one();
        (dropped, depth)
    }

    /// Release retained audio and its allocation. Admission stays closed until
    /// resume, including a capture already in flight when suspension began.
    pub fn suspend(&self) {
        *self.packets.lock().expect("packet queue poisoned") = None;
        self.ready.notify_one();
    }

    pub fn resume(&self) {
        self.packets
            .lock()
            .expect("packet queue poisoned")
            .get_or_insert_with(PacketStorage::new);
    }

    /// Wait up to `timeout` for a packet, returning it and the remaining
    /// depth, or `None` when the queue stayed empty. The bound keeps the
    /// consumer responsive to control requests (a transport quiesce) that
    /// arrive while no audio flows.
    pub fn pop_timeout(&self, timeout: Duration) -> Option<(T, usize)> {
        let packets = self.packets.lock().expect("packet queue poisoned");
        let (mut packets, _) = self
            .ready
            .wait_timeout_while(packets, timeout, |packets| {
                packets.as_ref().is_some_and(|packets| packets.len == 0)
            })
            .expect("packet queue poisoned");
        let packets = packets.as_mut()?;
        let packet = packets.pop_front()?;
        Some((packet, packets.len))
    }
}

impl<T> Default for PacketQueue<T> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, time::Duration};

    use super::{PacketQueue, QUEUE_DEPTH};

    fn pop(queue: &PacketQueue<u32>) -> Option<(u32, usize)> {
        queue.pop_timeout(Duration::ZERO)
    }

    #[test]
    fn a_two_hundred_millisecond_send_stall_preserves_the_captured_audio() {
        use crate::protocol::{FRAMES_PER_PACKET, SAMPLE_RATE_HZ};

        let packets = (SAMPLE_RATE_HZ * 200).div_ceil(FRAMES_PER_PACKET * 1000);
        let queue = PacketQueue::new();
        for sequence in 0..packets {
            assert!(!queue.push_drop_oldest(sequence).0);
        }
        for sequence in 0..packets {
            assert_eq!(pop(&queue).map(|(packet, _)| packet), Some(sequence));
        }
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
    fn wrapped_storage_preserves_order_without_growing_allocations() {
        let queue = PacketQueue::new();
        let capacities = || {
            queue
                .packets
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .chunks
                .each_ref()
                .map(VecDeque::capacity)
        };
        let allocated = capacities();
        assert!(allocated
            .iter()
            .all(|&capacity| capacity == super::CHUNK_DEPTH));
        for value in 0..200_u32 {
            queue.push_drop_oldest(value);
        }
        for value in 152..175 {
            assert_eq!(pop(&queue).map(|(packet, _)| packet), Some(value));
        }
        for value in 200..223 {
            queue.push_drop_oldest(value);
        }
        for value in 175..223 {
            assert_eq!(pop(&queue).map(|(packet, _)| packet), Some(value));
        }
        assert_eq!(pop(&queue), None);
        assert_eq!(capacities(), allocated);
    }

    #[test]
    fn audio_storage_resumes_without_a_large_contiguous_allocation() {
        use crate::packet::AudioPacket;

        let queue = PacketQueue::<AudioPacket>::new();
        for _ in 0..2 {
            {
                let state = queue.packets.lock().unwrap();
                let storage = state.as_ref().unwrap();
                let capacities = storage.chunks.each_ref().map(VecDeque::capacity);
                assert_eq!(capacities.iter().sum::<usize>(), 48);
                // HTTPS can leave enough total heap but no large contiguous block.
                assert!(capacities
                    .iter()
                    .all(|capacity| capacity * std::mem::size_of::<AudioPacket>() <= 16 * 1024));
            }
            queue.suspend();
            queue.resume();
        }
    }

    #[test]
    fn an_empty_queue_times_out_with_no_packet() {
        let queue = PacketQueue::<u32>::new();
        assert_eq!(queue.pop_timeout(Duration::from_millis(1)), None);
    }

    #[test]
    fn suspension_releases_storage_and_rejects_in_flight_capture_until_resume() {
        let queue = PacketQueue::new();
        queue.push_drop_oldest(1);
        queue.suspend();
        assert!(queue.packets.lock().unwrap().is_none());
        assert_eq!(queue.push_drop_oldest(2), (false, 0));
        assert!(queue.packets.lock().unwrap().is_none());
        assert_eq!(pop(&queue), None);
        queue.resume();
        queue.push_drop_oldest(3);
        queue.resume();
        assert_eq!(pop(&queue), Some((3, 0)));
    }
}
