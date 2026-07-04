//! Task topology for the capture-to-TCP streaming pipeline.

use core::ffi::CStr;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
};

use anyhow::{Context, Result};
use esp_idf_svc::hal::{cpu::Core, delay::FreeRtos, task::thread::ThreadSpawnConfiguration};

use crate::{
    adapters::{
        i2s::Capture,
        tcp::{TargetAddress, TcpClient},
    },
    counter::Counter64,
    levels::LevelStats,
    packet::AudioPacket,
    play::PlayDetector,
    protocol::PAYLOAD_BYTES,
};

const QUEUE_DEPTH: usize = 32;
const TASK_STACK_BYTES: usize = 8_192;
const CAPTURE_PRIORITY: u8 = 3;
const NETWORK_PRIORITY: u8 = 2;

/// Atomics keep HTTP status reads out of both real-time task critical paths.
#[derive(Default)]
pub struct StreamStatus {
    sequence: AtomicU32,
    packets: Counter64,
    bytes: Counter64,
    read_errors: Counter64,
    short_reads: Counter64,
    queue_drops: Counter64,
    network_errors: Counter64,
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

    pub fn snapshot(&self) -> StreamSnapshot {
        StreamSnapshot {
            sequence: self.sequence.load(Ordering::Relaxed),
            packets: self.packets.load(),
            bytes: self.bytes.load(),
            read_errors: self.read_errors.load(),
            short_reads: self.short_reads.load(),
            queue_drops: self.queue_drops.load(),
            network_errors: self.network_errors.load(),
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

    fn record_levels(&self, levels: LevelStats) {
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
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamSnapshot {
    pub sequence: u32,
    pub packets: u64,
    pub bytes: u64,
    pub read_errors: u64,
    pub short_reads: u64,
    pub queue_drops: u64,
    pub network_errors: u64,
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

struct PacketQueue {
    packets: Mutex<VecDeque<AudioPacket>>,
    ready: Condvar,
}

impl PacketQueue {
    fn new() -> Self {
        Self {
            packets: Mutex::new(VecDeque::with_capacity(QUEUE_DEPTH)),
            ready: Condvar::new(),
        }
    }

    /// Capture never blocks behind a slow receiver. At capacity discard the
    /// oldest packet, keeping latency bounded and the newest signal available.
    fn push_drop_oldest(&self, packet: AudioPacket) -> (bool, usize) {
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

    fn pop(&self) -> (AudioPacket, usize) {
        let mut packets = self.packets.lock().expect("packet queue poisoned");
        loop {
            if let Some(packet) = packets.pop_front() {
                return (packet, packets.len());
            }
            packets = self.ready.wait(packets).expect("packet queue poisoned");
        }
    }
}

pub fn start(capture: Capture, target: TargetAddress) -> Result<Arc<StreamStatus>> {
    let status = Arc::new(StreamStatus::default());
    let queue = Arc::new(PacketQueue::new());

    let capture_status = Arc::clone(&status);
    let capture_queue = Arc::clone(&queue);
    spawn_pinned(c"capture", CAPTURE_PRIORITY, move || {
        capture_loop(capture, capture_queue, capture_status)
    })?;

    let network_status = Arc::clone(&status);
    spawn_pinned(c"network", NETWORK_PRIORITY, move || {
        network_loop(TcpClient::new(target), queue, network_status)
    })?;
    Ok(status)
}

fn capture_loop(mut capture: Capture, queue: Arc<PacketQueue>, status: Arc<StreamStatus>) -> ! {
    let mut pcm = [0_u8; PAYLOAD_BYTES];
    // The capture task owns play detection: only packets captured while the
    // input carries signal are enqueued, so the network task simply drains the
    // queue and an idle input costs no bandwidth. Sequence numbers keep
    // counting while idle — the gap tells the bridge how much time passed.
    let mut detector = PlayDetector::new();
    loop {
        if status.relearn.swap(false, Ordering::Relaxed) {
            detector = PlayDetector::new();
            // Clips counted under a different input scale say nothing about
            // these settings; the UI reports this as "since levels were set".
            status.clipped_total.reset();
        }
        let bytes = match capture.read(&mut pcm) {
            Ok(bytes) => bytes,
            Err(error) => {
                status.read_errors.add(1);
                log::error!("I2S read failed: {error:#}");
                FreeRtos::delay_ms(100);
                continue;
            }
        };
        if bytes == 0 || bytes % 4 != 0 {
            status.short_reads.add(1);
            continue;
        }
        if bytes != PAYLOAD_BYTES {
            status.short_reads.add(1);
        }
        let levels = LevelStats::analyze(&pcm[..bytes]);
        status.record_levels(levels);
        let playing = detector.update(levels);
        status.playing.store(playing, Ordering::Relaxed);
        status
            .noise_floor
            .store(u32::from(detector.noise_floor()), Ordering::Relaxed);
        let sequence = status.sequence.fetch_add(1, Ordering::Relaxed);
        if !playing {
            continue;
        }
        let Some(packet) = AudioPacket::from_pcm(sequence, &pcm[..bytes]) else {
            status.short_reads.add(1);
            continue;
        };
        let (dropped, depth) = queue.push_drop_oldest(packet);
        if dropped {
            status.queue_drops.add(1);
        }
        status.queue_depth.store(depth as u32, Ordering::Relaxed);
    }
}

fn network_loop(mut tcp: TcpClient, queue: Arc<PacketQueue>, status: Arc<StreamStatus>) -> ! {
    loop {
        let (packet, depth) = queue.pop();
        status.queue_depth.store(depth as u32, Ordering::Relaxed);
        loop {
            match tcp.send_all(packet.as_bytes()) {
                Ok(reconnected) => {
                    if reconnected && status.packets.load() > 0 {
                        status.reconnects.add(1);
                    }
                    status.packets.add(1);
                    status.bytes.add(packet.payload_bytes() as u32);
                    break;
                }
                Err(error) => {
                    status.network_errors.add(1);
                    log::warn!("TCP stream error: {error:#}");
                    FreeRtos::delay_ms(250);
                }
            }
        }
    }
}

/// Spawn a real-time task pinned to the application core. `std::thread` on
/// ESP-IDF is backed by FreeRTOS tasks; [`ThreadSpawnConfiguration`] supplies
/// the name, priority, and core affinity the raw FreeRTOS API would otherwise
/// require unsafe FFI to set.
fn spawn_pinned(
    name: &'static CStr,
    priority: u8,
    task: impl FnOnce() + Send + 'static,
) -> Result<()> {
    ThreadSpawnConfiguration {
        name: Some(name),
        stack_size: TASK_STACK_BYTES,
        priority,
        pin_to_core: Some(Core::Core1),
        ..Default::default()
    }
    .set()
    .context("cannot configure streaming task")?;

    let spawned = thread::Builder::new()
        .stack_size(TASK_STACK_BYTES)
        .spawn(task)
        .context("cannot spawn streaming task");

    // Restore defaults so unrelated threads (e.g. the HTTP server) are unaffected.
    ThreadSpawnConfiguration::default()
        .set()
        .context("cannot restore default task configuration")?;

    spawned.map(drop)
}
