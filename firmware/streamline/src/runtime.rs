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
    levels::{LevelStats, SILENCE_RMS_THRESHOLD},
    packet::AudioPacket,
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
    packets: AtomicU32,
    bytes: AtomicU32,
    read_errors: AtomicU32,
    short_reads: AtomicU32,
    queue_drops: AtomicU32,
    network_errors: AtomicU32,
    reconnects: AtomicU32,
    queue_depth: AtomicU32,
    peak_left: AtomicU32,
    peak_right: AtomicU32,
    rms_left: AtomicU32,
    rms_right: AtomicU32,
    clipped_total: AtomicU32,
    silence_packets: AtomicU32,
    playing: AtomicBool,
}

impl StreamStatus {
    pub fn snapshot(&self) -> StreamSnapshot {
        StreamSnapshot {
            sequence: self.sequence.load(Ordering::Relaxed),
            packets: self.packets.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            read_errors: self.read_errors.load(Ordering::Relaxed),
            short_reads: self.short_reads.load(Ordering::Relaxed),
            queue_drops: self.queue_drops.load(Ordering::Relaxed),
            network_errors: self.network_errors.load(Ordering::Relaxed),
            reconnects: self.reconnects.load(Ordering::Relaxed),
            queue_depth: self.queue_depth.load(Ordering::Relaxed),
            peak_left: self.peak_left.load(Ordering::Relaxed),
            peak_right: self.peak_right.load(Ordering::Relaxed),
            rms_left: self.rms_left.load(Ordering::Relaxed),
            rms_right: self.rms_right.load(Ordering::Relaxed),
            clipped_total: self.clipped_total.load(Ordering::Relaxed),
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
            self.clipped_total
                .fetch_add(levels.clipped, Ordering::Relaxed);
        }
        // Silence detection: both channels must be below threshold.
        let is_silent =
            levels.rms_left < SILENCE_RMS_THRESHOLD && levels.rms_right < SILENCE_RMS_THRESHOLD;
        if is_silent {
            self.silence_packets.fetch_add(1, Ordering::Relaxed);
        } else {
            let count = self.silence_packets.load(Ordering::Relaxed);
            if count > 0 {
                self.silence_packets
                    .fetch_sub(count.min(SILENCE_HYSTERESIS), Ordering::Relaxed);
            }
        }
        let silence_count = self.silence_packets.load(Ordering::Relaxed);
        if silence_count >= SILENCE_DETECTION_WINDOW {
            self.playing.store(false, Ordering::Relaxed);
        } else if silence_count == 0 {
            self.playing.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamSnapshot {
    pub sequence: u32,
    pub packets: u32,
    pub bytes: u32,
    pub read_errors: u32,
    pub short_reads: u32,
    pub queue_drops: u32,
    pub network_errors: u32,
    pub reconnects: u32,
    pub queue_depth: u32,
    pub peak_left: u32,
    pub peak_right: u32,
    pub rms_left: u32,
    pub rms_right: u32,
    pub clipped_total: u32,
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
    loop {
        let bytes = match capture.read(&mut pcm) {
            Ok(bytes) => bytes,
            Err(error) => {
                status.read_errors.fetch_add(1, Ordering::Relaxed);
                log::error!("I2S read failed: {error:#}");
                FreeRtos::delay_ms(100);
                continue;
            }
        };
        if bytes == 0 || bytes % 4 != 0 {
            status.short_reads.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        if bytes != PAYLOAD_BYTES {
            status.short_reads.fetch_add(1, Ordering::Relaxed);
        }
        status.record_levels(LevelStats::analyze(&pcm[..bytes]));
        let sequence = status.sequence.fetch_add(1, Ordering::Relaxed);
        let Some(packet) = AudioPacket::from_pcm(sequence, &pcm[..bytes]) else {
            status.short_reads.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let (dropped, depth) = queue.push_drop_oldest(packet);
        if dropped {
            status.queue_drops.fetch_add(1, Ordering::Relaxed);
        }
        status.queue_depth.store(depth as u32, Ordering::Relaxed);
    }
}

const SILENCE_DETECTION_WINDOW: u32 = 5;
const SILENCE_HYSTERESIS: u32 = 2;

fn network_loop(mut tcp: TcpClient, queue: Arc<PacketQueue>, status: Arc<StreamStatus>) -> ! {
    loop {
        if !status.playing.load(Ordering::Relaxed) {
            FreeRtos::delay_ms(100);
            continue;
        }
        let (packet, depth) = queue.pop();
        status.queue_depth.store(depth as u32, Ordering::Relaxed);
        loop {
            match tcp.send_all(packet.as_bytes()) {
                Ok(reconnected) => {
                    if reconnected && status.packets.load(Ordering::Relaxed) > 0 {
                        status.reconnects.fetch_add(1, Ordering::Relaxed);
                    }
                    status.packets.fetch_add(1, Ordering::Relaxed);
                    status
                        .bytes
                        .fetch_add(packet.payload_bytes() as u32, Ordering::Relaxed);
                    break;
                }
                Err(error) => {
                    status.network_errors.fetch_add(1, Ordering::Relaxed);
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
