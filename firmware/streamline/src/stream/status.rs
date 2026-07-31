//! Streaming counters read by the HTTP status endpoint.

use core::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

use crate::levels::LevelStats;

/// Running 64-bit totals. This target's native atomics stop at 32 bits, so the
/// totals live behind one short blocking lock; every hold is a handful of plain
/// field reads or writes with nothing blocking inside. A reader that arrives
/// mid-update must sleep, never spin: a spinning high-priority reader (an HTTP
/// scrape, the status-light task) starves a preempted lower-priority streaming
/// writer on the same core, and both sides hang forever.
#[derive(Default)]
struct Totals {
    packets: u64,
    bytes: u64,
    read_errors: u64,
    short_reads: u64,
    queue_drops: u64,
    stale_drops: u64,
    network_errors: u64,
    tls_handshake_failures: u64,
    reconnects: u64,
    send_stalls: u64,
    longest_send_stall_ms: u64,
    clipped: u64,
}

/// Live meters stay in native 32-bit atomics so the capture task updates them
/// without touching the totals lock; the totals above take the lock once per
/// event. The capture and network engines record through the methods below
/// rather than touching fields, so every counter has one owner and stays
/// host-testable.
#[derive(Default)]
pub struct StreamStatus {
    sequence: AtomicU32,
    totals: Mutex<Totals>,
    queue_depth: AtomicU32,
    peak_left: AtomicU32,
    peak_right: AtomicU32,
    rms_left: AtomicU32,
    rms_right: AtomicU32,
    noise_floor: AtomicU32,
    playing: AtomicBool,
    relearn: AtomicBool,
    /// Streaming pause: while set, captured packets are analyzed for the
    /// meters but never enqueued. Runtime-only state — a reboot resumes
    /// streaming — flipped by `POST /api/stream` and the `toggle_stream`
    /// button action.
    paused: AtomicBool,
    /// Transport quiesce: while set, capture stops enqueuing and the network
    /// task closes its connection, freeing the socket and TLS buffers a
    /// firmware install needs. Requested by the OTA worker; cleared by it to
    /// resume streaming after a failed install.
    transport_quiesce: AtomicBool,
    /// Whether the network task currently holds an open connection. The OTA
    /// worker waits for `false` after requesting quiesce; a device without a
    /// network task never connects, so the wait ends immediately.
    transport_connected: AtomicBool,
}

impl StreamStatus {
    fn totals(&self) -> std::sync::MutexGuard<'_, Totals> {
        self.totals.lock().expect("stream totals poisoned")
    }

    /// Pause or resume enqueuing captured audio. Capture and level analysis
    /// continue either way, so the meters stay live while paused.
    pub fn set_streaming_enabled(&self, enabled: bool) {
        self.paused.store(!enabled, Ordering::Relaxed);
    }

    /// Whether captured packets are currently allowed onto the wire.
    pub fn streaming_enabled(&self) -> bool {
        !self.paused.load(Ordering::Relaxed)
    }

    /// Ask the pipeline to release the PCM transport: capture stops enqueuing
    /// and the network task closes its connection, freeing its buffers. Poll
    /// [`Self::transport_connected`] for completion.
    pub fn request_transport_quiesce(&self) {
        self.transport_quiesce.store(true, Ordering::Relaxed);
    }

    /// Let the pipeline reconnect and stream again after a quiesce.
    pub fn end_transport_quiesce(&self) {
        self.transport_quiesce.store(false, Ordering::Relaxed);
    }

    /// Whether a transport quiesce is in force.
    pub(crate) fn transport_quiesce_requested(&self) -> bool {
        self.transport_quiesce.load(Ordering::Relaxed)
    }

    /// Whether the network task holds an open connection right now.
    pub fn transport_connected(&self) -> bool {
        self.transport_connected.load(Ordering::Relaxed)
    }

    /// Record whether the network task holds an open connection; maintained by
    /// the network engine on every connect, send failure, and quiesce.
    pub(crate) fn set_transport_connected(&self, connected: bool) {
        self.transport_connected.store(connected, Ordering::Relaxed);
    }

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
        self.totals().clipped = 0;
    }

    pub(crate) fn record_read_error(&self) {
        self.totals().read_errors += 1;
    }

    pub(crate) fn record_short_read(&self) {
        self.totals().short_reads += 1;
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
            self.totals().clipped += u64::from(levels.clipped);
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
        self.totals().queue_drops += 1;
    }

    /// Account one packet discarded because retrying it outlived the queue's
    /// latency bound.
    pub(crate) fn record_stale_drop(&self) {
        self.totals().stale_drops += 1;
    }

    pub(crate) fn set_queue_depth(&self, depth: usize) {
        self.queue_depth.store(depth as u32, Ordering::Relaxed);
    }

    /// Account one delivered packet. A send on a fresh connection counts as a
    /// reconnect only after the first success, so the initial connect is not
    /// miscounted.
    pub(crate) fn record_sent(&self, payload_bytes: usize, reconnected: bool) {
        let mut totals = self.totals();
        if reconnected && totals.packets > 0 {
            totals.reconnects += 1;
        }
        totals.packets += 1;
        totals.bytes += payload_bytes as u64;
    }

    /// Account one delivered packet whose send held the pipeline unusually
    /// long — the early-warning signal that the link is stalling and the
    /// queue is about to drop audio.
    pub(crate) fn record_send_stall(&self, stall_ms: u64) {
        let mut totals = self.totals();
        totals.send_stalls += 1;
        totals.longest_send_stall_ms = totals.longest_send_stall_ms.max(stall_ms);
    }

    pub(crate) fn record_network_error(&self, secure_handshake: bool) {
        let mut totals = self.totals();
        totals.network_errors += 1;
        if secure_handshake {
            totals.tls_handshake_failures += 1;
        }
    }

    pub fn snapshot(&self) -> StreamSnapshot {
        let totals = self.totals();
        StreamSnapshot {
            sequence: self.sequence.load(Ordering::Relaxed),
            packets: totals.packets,
            bytes: totals.bytes,
            read_errors: totals.read_errors,
            short_reads: totals.short_reads,
            queue_drops: totals.queue_drops,
            stale_drops: totals.stale_drops,
            network_errors: totals.network_errors,
            tls_handshake_failures: totals.tls_handshake_failures,
            reconnects: totals.reconnects,
            send_stalls: totals.send_stalls,
            longest_send_stall_ms: totals.longest_send_stall_ms,
            clipped_total: totals.clipped,
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            peak_left: self.peak_left.load(Ordering::Relaxed),
            peak_right: self.peak_right.load(Ordering::Relaxed),
            rms_left: self.rms_left.load(Ordering::Relaxed),
            rms_right: self.rms_right.load(Ordering::Relaxed),
            noise_floor: self.noise_floor.load(Ordering::Relaxed),
            playing: self.playing.load(Ordering::Relaxed),
            streaming_enabled: self.streaming_enabled(),
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
    pub send_stalls: u64,
    pub longest_send_stall_ms: u64,
    pub queue_depth: u32,
    pub peak_left: u32,
    pub peak_right: u32,
    pub rms_left: u32,
    pub rms_right: u32,
    pub noise_floor: u32,
    pub clipped_total: u64,
    pub playing: bool,
    pub streaming_enabled: bool,
}

#[cfg(test)]
mod tests {
    use super::StreamStatus;

    #[test]
    fn totals_accumulate_past_the_32_bit_boundary() {
        let status = StreamStatus::default();

        status.record_sent(usize::try_from(u32::MAX).unwrap(), false);
        status.record_sent(10, false);

        let snapshot = status.snapshot();
        assert_eq!(snapshot.packets, 2);
        assert_eq!(snapshot.bytes, u64::from(u32::MAX) + 10);
    }

    #[test]
    fn send_stalls_count_and_keep_the_longest_duration() {
        let status = StreamStatus::default();

        status.record_send_stall(150);
        status.record_send_stall(900);
        status.record_send_stall(200);

        let snapshot = status.snapshot();
        assert_eq!(snapshot.send_stalls, 3);
        assert_eq!(snapshot.longest_send_stall_ms, 900);
    }
}
