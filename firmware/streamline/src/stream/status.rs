//! Lock-free streaming counters read by the HTTP status endpoint.

use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use crate::{counter::Counter64, levels::LevelStats};

/// Atomics keep HTTP status reads out of both real-time task critical paths.
/// The capture and network engines record through the methods below rather than
/// touching fields, so every counter has one owner and stays host-testable.
#[derive(Default)]
pub struct StreamStatus {
    sequence: AtomicU32,
    packets: Counter64,
    bytes: Counter64,
    read_errors: Counter64,
    short_reads: Counter64,
    queue_drops: Counter64,
    stale_drops: Counter64,
    network_errors: Counter64,
    tls_handshake_failures: Counter64,
    reconnects: Counter64,
    queue_depth: AtomicU32,
    peak_left: AtomicU32,
    peak_right: AtomicU32,
    rms_left: AtomicU32,
    rms_right: AtomicU32,
    noise_floor: AtomicU32,
    clipped_total: Counter64,
    playing: AtomicBool,
    relearn: AtomicBool,
}

impl StreamStatus {
    /// Ask the capture task to restart play detection from scratch. Called
    /// after a live codec change: the idle estimate and thresholds belong to a
    /// different input scale and must be rebuilt before gating the signal.
    pub fn request_relearn(&self) {
        self.relearn.store(true, Ordering::Relaxed);
    }

    /// Take a pending relearn request. When set, the capture task rebuilds its
    /// detector and clears clips gathered under the old input scale.
    pub(crate) fn take_relearn(&self) -> bool {
        self.relearn.swap(false, Ordering::Relaxed)
    }

    pub(crate) fn reset_clipped(&self) {
        self.clipped_total.reset();
    }

    pub(crate) fn record_read_error(&self) {
        self.read_errors.add(1);
    }

    pub(crate) fn record_short_read(&self) {
        self.short_reads.add(1);
    }

    pub(crate) fn record_levels(&self, levels: LevelStats) {
        self.peak_left
            .store(u32::from(levels.peak_left), Ordering::Relaxed);
        self.peak_right
            .store(u32::from(levels.peak_right), Ordering::Relaxed);
        self.rms_left
            .store(u32::from(levels.rms_left), Ordering::Relaxed);
        self.rms_right
            .store(u32::from(levels.rms_right), Ordering::Relaxed);
        if levels.clipped > 0 {
            self.clipped_total.add(levels.clipped);
        }
    }

    pub(crate) fn set_playing(&self, playing: bool) {
        self.playing.store(playing, Ordering::Relaxed);
    }

    pub(crate) fn set_noise_floor(&self, noise_floor: u16) {
        self.noise_floor
            .store(u32::from(noise_floor), Ordering::Relaxed);
    }

    /// Take the next packet sequence number. Idle packets consume one too, so a
    /// gap tells the bridge how much time passed while the input was silent.
    pub(crate) fn next_sequence(&self) -> u32 {
        self.sequence.fetch_add(1, Ordering::Relaxed)
    }

    /// The sequence number the capture task will hand out next. The network
    /// task compares it against an in-flight packet to bound retry age.
    pub(crate) fn sequence(&self) -> u32 {
        self.sequence.load(Ordering::Relaxed)
    }

    pub(crate) fn record_queue_drop(&self) {
        self.queue_drops.add(1);
    }

    /// Account one packet discarded because retrying it outlived the queue's
    /// latency bound.
    pub(crate) fn record_stale_drop(&self) {
        self.stale_drops.add(1);
    }

    pub(crate) fn set_queue_depth(&self, depth: usize) {
        self.queue_depth.store(depth as u32, Ordering::Relaxed);
    }

    /// Account one delivered packet. A send on a fresh connection counts as a
    /// reconnect only after the first success, so the initial connect is not
    /// miscounted.
    pub(crate) fn record_sent(&self, payload_bytes: usize, reconnected: bool) {
        if reconnected && self.packets.load() > 0 {
            self.reconnects.add(1);
        }
        self.packets.add(1);
        self.bytes.add(payload_bytes as u32);
    }

    pub(crate) fn record_network_error(&self, secure_handshake: bool) {
        self.network_errors.add(1);
        if secure_handshake {
            self.tls_handshake_failures.add(1);
        }
    }

    pub fn snapshot(&self) -> StreamSnapshot {
        StreamSnapshot {
            sequence: self.sequence.load(Ordering::Relaxed),
            packets: self.packets.load(),
            bytes: self.bytes.load(),
            read_errors: self.read_errors.load(),
            short_reads: self.short_reads.load(),
            queue_drops: self.queue_drops.load(),
            stale_drops: self.stale_drops.load(),
            network_errors: self.network_errors.load(),
            tls_handshake_failures: self.tls_handshake_failures.load(),
            reconnects: self.reconnects.load(),
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            peak_left: self.peak_left.load(Ordering::Relaxed),
            peak_right: self.peak_right.load(Ordering::Relaxed),
            rms_left: self.rms_left.load(Ordering::Relaxed),
            rms_right: self.rms_right.load(Ordering::Relaxed),
            noise_floor: self.noise_floor.load(Ordering::Relaxed),
            clipped_total: self.clipped_total.load(),
            playing: self.playing.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamSnapshot {
    pub sequence: u32,
    pub packets: u64,
    pub bytes: u64,
    pub read_errors: u64,
    pub short_reads: u64,
    pub queue_drops: u64,
    pub stale_drops: u64,
    pub network_errors: u64,
    pub tls_handshake_failures: u64,
    pub reconnects: u64,
    pub queue_depth: u32,
    pub peak_left: u32,
    pub peak_right: u32,
    pub rms_left: u32,
    pub rms_right: u32,
    pub noise_floor: u32,
    pub clipped_total: u64,
    pub playing: bool,
}
