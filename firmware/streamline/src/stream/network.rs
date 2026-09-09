//! Send queued PCM only while its capture timestamp and control state permit it.

use super::{
    effects::{Clock, Delay, PacketSink},
    queue::{PacketQueue, QUEUE_DEPTH},
    status::StreamStatus,
};
use crate::{
    packet::AudioPacket,
    protocol::{FRAMES_PER_PACKET, SAMPLE_RATE_HZ},
};
use std::{sync::Arc, time::Duration};

const SEND_ERROR_BACKOFF_MS: u32 = 250;
const CONTROL_POLL_MS: u32 = 100;
const SEND_STALL_MS: u64 = 100;
const MAX_PACKET_AGE_MS: u64 =
    QUEUE_DEPTH as u64 * FRAMES_PER_PACKET as u64 * 1000 / SAMPLE_RATE_HZ as u64;

pub fn run(
    mut sink: impl PacketSink,
    queue: Arc<PacketQueue<AudioPacket>>,
    status: Arc<StreamStatus>,
    delay: impl Delay,
    clock: impl Clock,
) -> ! {
    loop {
        step(&mut sink, &queue, &status, &delay, &clock);
    }
}

fn sending_allowed(status: &StreamStatus) -> bool {
    status.streaming_enabled() && !status.transport_quiesce_requested()
}

fn step(
    sink: &mut impl PacketSink,
    queue: &PacketQueue<AudioPacket>,
    status: &StreamStatus,
    delay: &impl Delay,
    clock: &impl Clock,
) {
    if !sending_allowed(status) {
        sink.disconnect();
        queue.clear();
        status.set_queue_depth(0);
        if status.transport_quiesce_requested() {
            status.acknowledge_transport_quiesced();
        }
        delay.delay_ms(CONTROL_POLL_MS);
        return;
    }
    let Some((packet, depth)) =
        queue.pop_timeout(Duration::from_millis(u64::from(CONTROL_POLL_MS)))
    else {
        return;
    };
    status.set_queue_depth(depth);
    send_packet(sink, &packet, status, delay, clock);
}

fn send_packet(
    sink: &mut impl PacketSink,
    packet: &AudioPacket,
    status: &StreamStatus,
    delay: &impl Delay,
    clock: &impl Clock,
) {
    let ready =
        || sending_allowed(status) && packet.age_ms(clock.monotonic_millis()) < MAX_PACKET_AGE_MS;
    if !ready() {
        if sending_allowed(status) {
            status.record_stale_drop();
        }
        return;
    }
    let started = clock.monotonic_millis();
    match sink.send(packet.as_bytes(), ready) {
        Ok(Some(reconnected)) => {
            let elapsed = clock.monotonic_millis().saturating_sub(started);
            if elapsed >= SEND_STALL_MS {
                status.record_send_stall(elapsed);
                log::warn!("PCM send stalled for {elapsed} ms");
            }
            status.record_sent(packet.payload_bytes(), reconnected);
        }
        Ok(None) => {
            if sending_allowed(status) {
                status.record_stale_drop();
            }
        }
        Err(failure) => {
            status.record_network_error(failure.secure_handshake);
            // Backoff exceeds the packet age budget; resume with fresh queued audio.
            delay.delay_ms(SEND_ERROR_BACKOFF_MS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{protocol::PAYLOAD_BYTES, stream::SendFailed};
    use std::{cell::Cell, rc::Rc};

    #[derive(Clone, Default)]
    struct Time(Rc<Cell<u64>>);
    impl Clock for Time {
        fn monotonic_millis(&self) -> u64 {
            self.0.get()
        }
    }
    impl Delay for Time {
        fn delay_ms(&self, millis: u32) {
            self.0.set(self.0.get() + u64::from(millis));
        }
    }

    struct Sink<'a> {
        time: Time,
        connect_ms: u32,
        write_ms: u32,
        calls: usize,
        writes: usize,
        disconnects: usize,
        failure: Option<bool>,
        control: Option<(&'a StreamStatus, bool)>,
    }
    impl PacketSink for Sink<'_> {
        fn send(
            &mut self,
            _: &[u8],
            ready: impl FnOnce() -> bool,
        ) -> Result<Option<bool>, SendFailed> {
            self.calls += 1;
            self.time.delay_ms(self.connect_ms);
            if let Some((status, quiesce)) = self.control {
                if quiesce {
                    status.request_transport_quiesce();
                } else {
                    status.set_streaming_enabled(false);
                }
            }
            if !ready() {
                return Ok(None);
            }
            if let Some(secure_handshake) = self.failure {
                return Err(SendFailed { secure_handshake });
            }
            self.writes += 1;
            self.time.delay_ms(self.write_ms);
            Ok(Some(true))
        }
        fn disconnect(&mut self) {
            self.disconnects += 1;
        }
    }
    fn sink(time: &Time) -> Sink<'_> {
        Sink {
            time: time.clone(),
            connect_ms: 0,
            write_ms: 0,
            calls: 0,
            writes: 0,
            disconnects: 0,
            failure: None,
            control: None,
        }
    }
    fn packet(at: u64) -> AudioPacket {
        AudioPacket::from_pcm(0, at, &[0; PAYLOAD_BYTES])
    }

    #[test]
    fn expired_audio_is_dropped_even_when_capture_stops() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut sink = sink(&time);
        time.delay_ms(MAX_PACKET_AGE_MS as u32);
        send_packet(&mut sink, &packet(0), &status, &time, &time);
        assert_eq!(sink.calls, 0);
        assert_eq!(status.snapshot().stale_drops, 1);
        assert_eq!(status.snapshot().sequence, 0);
    }

    #[test]
    fn connection_setup_cannot_send_an_expired_packet() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut sink = sink(&time);
        sink.connect_ms = 2_000;
        send_packet(&mut sink, &packet(0), &status, &time, &time);
        assert_eq!(sink.calls, 1);
        assert_eq!(sink.writes, 0);
        assert_eq!(status.snapshot().stale_drops, 1);
    }

    #[test]
    fn control_changes_during_connection_setup_cancel_the_write() {
        for quiesce in [false, true] {
            let time = Time::default();
            let status = StreamStatus::default();
            status.mark_transport_present();
            let mut sink = sink(&time);
            sink.control = Some((&status, quiesce));
            send_packet(&mut sink, &packet(0), &status, &time, &time);
            assert_eq!(sink.writes, 0);
            assert_eq!(status.snapshot().stale_drops, 0);
            assert!(!status.transport_quiesced());
        }
    }

    #[test]
    fn failed_packets_are_not_replayed_after_backoff() {
        for secure in [false, true] {
            let time = Time::default();
            let status = StreamStatus::default();
            status.mark_transport_present();
            let mut sink = sink(&time);
            sink.failure = Some(secure);
            send_packet(&mut sink, &packet(0), &status, &time, &time);
            assert_eq!(sink.calls, 1);
            assert_eq!(status.snapshot().network_errors, 1);
            assert_eq!(status.snapshot().tls_handshake_failures, u64::from(secure));
            assert!(!status.transport_quiesced());
            assert_eq!(time.monotonic_millis(), u64::from(SEND_ERROR_BACKOFF_MS));
        }
    }

    #[test]
    fn successful_sends_account_payload_reconnects_and_stalls() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut sink = sink(&time);
        send_packet(&mut sink, &packet(0), &status, &time, &time);
        assert_eq!(status.snapshot().reconnects, 0);
        sink.write_ms = SEND_STALL_MS as u32;
        send_packet(&mut sink, &packet(0), &status, &time, &time);
        let snapshot = status.snapshot();
        assert_eq!(snapshot.packets, 2);
        assert_eq!(snapshot.bytes, 2 * PAYLOAD_BYTES as u64);
        assert_eq!(snapshot.reconnects, 1);
        assert_eq!(snapshot.send_stalls, 1);
        assert_eq!(snapshot.longest_send_stall_ms, SEND_STALL_MS);
    }

    #[test]
    fn pause_and_quiesce_discard_queued_audio_and_release_the_connection() {
        for quiesce in [false, true] {
            let time = Time::default();
            let status = StreamStatus::default();
            status.mark_transport_present();
            let queue = PacketQueue::new();
            queue.push_drop_oldest(packet(0));
            if quiesce {
                status.request_transport_quiesce();
            } else {
                status.set_streaming_enabled(false);
            }
            let mut sink = sink(&time);
            step(&mut sink, &queue, &status, &time, &time);
            assert_eq!(sink.calls, 0);
            assert_eq!(sink.disconnects, 1);
            assert!(queue.pop_timeout(Duration::ZERO).is_none());
            assert_eq!(status.transport_quiesced(), quiesce);
            status.end_transport_quiesce();
            status.set_streaming_enabled(true);
            let now = time.monotonic_millis();
            queue.push_drop_oldest(packet(now));
            step(&mut sink, &queue, &status, &time, &time);
            assert_eq!(sink.writes, 1);
        }
    }
}
