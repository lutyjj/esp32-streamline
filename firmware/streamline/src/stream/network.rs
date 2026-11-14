//! Send retained PCM while streaming controls permit it.

use super::{
    effects::{Clock, Delay, PacketSink},
    queue::PacketQueue,
    retry::Retry,
    status::StreamStatus,
};
use crate::packet::{AudioPacket, MAX_PACKET_BYTES};
use std::{sync::Arc, time::Duration};

const CONTROL_POLL_MS: u32 = 100;
const SEND_STALL_MS: u64 = 100;
const BATCH_PACKETS: usize = 4;
const BATCH_WAIT_MS: u64 = 40;
pub const MAX_BATCH_BYTES: usize = BATCH_PACKETS * MAX_PACKET_BYTES;

pub fn run(
    mut sink: impl PacketSink,
    queue: Arc<PacketQueue<AudioPacket>>,
    status: Arc<StreamStatus>,
    delay: impl Delay,
    clock: impl Clock,
) -> ! {
    let mut batch = Vec::with_capacity(MAX_BATCH_BYTES);
    let mut retry = Retry::new();
    loop {
        step(
            &mut sink, &queue, &status, &mut retry, &delay, &clock, &mut batch,
        );
    }
}

fn sending_allowed(status: &StreamStatus) -> bool {
    status.streaming_enabled() && !status.transport_quiesce_requested()
}

fn step(
    sink: &mut impl PacketSink,
    queue: &PacketQueue<AudioPacket>,
    status: &StreamStatus,
    retry: &mut Retry,
    delay: &impl Delay,
    clock: &impl Clock,
    batch: &mut Vec<u8>,
) {
    batch.clear();
    if !sending_allowed(status) {
        sink.disconnect();
        queue.suspend();
        *batch = Vec::new();
        retry.restart_schedule();
        status.set_restart_needed(false);
        status.set_queue_depth(0);
        if status.transport_quiesce_requested() {
            status.acknowledge_transport_quiesced();
        }
        delay.delay_ms(CONTROL_POLL_MS);
        return;
    }
    // Wait in control-poll slices so a pause or quiesce is never held behind a retry.
    let wait = retry.wait_ms(clock.monotonic_millis());
    if wait > 0 {
        delay.delay_ms(wait.min(u64::from(CONTROL_POLL_MS)) as u32);
        return;
    }
    let now = clock.monotonic_millis();
    if let Err(cause) = reserve_storage(queue, batch) {
        status.set_restart_needed(retry.refuse_storage(now));
        report_failure(retry, now, cause.to_owned());
        return;
    }
    if retry.reserve_storage() {
        status.set_restart_needed(false);
    }
    let Some((packet, depth)) =
        queue.pop_timeout(Duration::from_millis(u64::from(CONTROL_POLL_MS)))
    else {
        return;
    };
    status.set_queue_depth(depth);
    batch.extend_from_slice(packet.as_bytes());
    let mut packets = 1;
    let mut payload_bytes = packet.payload_bytes();
    let deadline = clock.monotonic_millis().saturating_add(BATCH_WAIT_MS);
    while packets < BATCH_PACKETS && sending_allowed(status) {
        let remaining = deadline.saturating_sub(clock.monotonic_millis());
        let Some((packet, depth)) = queue.pop_timeout(Duration::from_millis(remaining)) else {
            break;
        };
        batch.extend_from_slice(packet.as_bytes());
        packets += 1;
        payload_bytes += packet.payload_bytes();
        status.set_queue_depth(depth);
    }
    send_batch(sink, batch, packets, payload_bytes, status, retry, clock);
}

fn send_batch(
    sink: &mut impl PacketSink,
    bytes: &[u8],
    packets: usize,
    payload_bytes: usize,
    status: &StreamStatus,
    retry: &mut Retry,
    clock: &impl Clock,
) {
    let ready = || sending_allowed(status);
    if !ready() {
        return;
    }
    let started = clock.monotonic_millis();
    let result = sink.send(bytes, ready);
    let now = clock.monotonic_millis();
    match result {
        Ok(Some(reconnected)) => {
            let elapsed = now.saturating_sub(started);
            if elapsed >= SEND_STALL_MS {
                status.record_send_stall(elapsed);
                log::warn!("PCM send stalled for {elapsed} ms");
            }
            status.record_sent_batch(packets, payload_bytes, reconnected);
            if let Some(failures) = retry.deliver(now, reconnected) {
                log::info!("PCM stream restored after {failures} failed attempts");
            }
        }
        Ok(None) => {}
        Err(failure) => {
            status.record_failed_send(packets);
            status.record_network_error(failure.secure_handshake);
            report_failure(retry, now, failure.cause);
        }
    }
}

/// Reallocate what a pause released. A fragmented heap can refuse it after
/// maintenance; streaming then stays paused until a retry succeeds or the
/// refusal lasts long enough to restart.
fn reserve_storage(
    queue: &PacketQueue<AudioPacket>,
    batch: &mut Vec<u8>,
) -> Result<(), &'static str> {
    queue
        .resume()
        .map_err(|_| "cannot reserve memory for queued audio")?;
    batch
        .try_reserve_exact(MAX_BATCH_BYTES)
        .map_err(|_| "cannot reserve memory for the send batch")
}

fn report_failure(retry: &mut Retry, now: u64, cause: String) {
    if let Some(cause) = retry.fail(now, cause) {
        log::warn!("PCM stream interrupted, retrying with backoff: {cause}");
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
        received: Vec<Vec<u8>>,
        failure: Option<bool>,
        control: Option<(&'a StreamStatus, bool)>,
    }
    impl PacketSink for Sink<'_> {
        fn send(
            &mut self,
            bytes: &[u8],
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
                return Err(SendFailed {
                    secure_handshake,
                    cause: "refused".into(),
                });
            }
            self.writes += 1;
            self.received.push(bytes.to_vec());
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
            received: Vec::new(),
            failure: None,
            control: None,
        }
    }
    fn packet() -> AudioPacket {
        AudioPacket::from_pcm(0, &[0; PAYLOAD_BYTES])
    }

    #[test]
    fn queued_packets_share_a_write_without_changing_the_wire_bytes() {
        let time = Time::default();
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut expected = Vec::new();
        for sequence in 0..4 {
            let packet = AudioPacket::from_pcm(sequence, &[sequence as u8; PAYLOAD_BYTES]);
            expected.extend_from_slice(packet.as_bytes());
            queue.push_drop_oldest(packet);
        }
        let mut sink = sink(&time);
        step(
            &mut sink,
            &queue,
            &status,
            &mut Retry::new(),
            &time,
            &time,
            &mut Vec::new(),
        );
        assert_eq!(sink.received, vec![expected]);
        assert_eq!(status.snapshot().packets, 4);
        assert_eq!(status.snapshot().bytes, 4 * PAYLOAD_BYTES as u64);
        assert_eq!(status.snapshot().queue_depth, 0);
    }

    #[test]
    fn a_partial_batch_flushes_when_capture_stops() {
        let time = Time::default();
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        queue.push_drop_oldest(packet());
        let mut sink = sink(&time);
        step(
            &mut sink,
            &queue,
            &status,
            &mut Retry::new(),
            &time,
            &time,
            &mut Vec::new(),
        );
        assert_eq!(sink.received, vec![packet().as_bytes().to_vec()]);
        assert_eq!(status.snapshot().packets, 1);
    }

    #[test]
    fn mixed_silence_batches_keep_the_packet_bound_and_payload_accounting() {
        let time = Time::default();
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut expected = Vec::new();
        for sequence in 0..5 {
            let packet = if sequence % 2 == 0 {
                AudioPacket::silence(sequence)
            } else {
                AudioPacket::from_pcm(sequence, &[7; PAYLOAD_BYTES])
            };
            if sequence < 4 {
                expected.extend_from_slice(packet.as_bytes());
            }
            queue.push_drop_oldest(packet);
        }
        let mut sink = sink(&time);
        step(
            &mut sink,
            &queue,
            &status,
            &mut Retry::new(),
            &time,
            &time,
            &mut Vec::new(),
        );
        assert_eq!(sink.received, vec![expected]);
        assert_eq!(status.snapshot().packets, 4);
        assert_eq!(status.snapshot().bytes, 2048);
        assert_eq!(status.snapshot().queue_depth, 1);
    }

    #[test]
    fn failed_batch_reports_affected_packets_separately_from_the_error_event() {
        let time = Time::default();
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        for _ in 0..4 {
            queue.push_drop_oldest(packet());
        }
        let mut sink = sink(&time);
        sink.failure = Some(false);
        step(
            &mut sink,
            &queue,
            &status,
            &mut Retry::new(),
            &time,
            &time,
            &mut Vec::new(),
        );
        assert_eq!(status.snapshot().network_errors, 1);
        assert_eq!(status.snapshot().send_failed_packets, 4);
        assert_eq!(status.snapshot().packets, 0);
    }

    #[test]
    fn batches_bound_each_write_and_count_reconnections_once() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut retry = Retry::new();
        let queue = PacketQueue::new();
        for _ in 0..8 {
            queue.push_drop_oldest(packet());
        }
        let mut sink = sink(&time);
        let mut batch = Vec::new();
        step(
            &mut sink, &queue, &status, &mut retry, &time, &time, &mut batch,
        );
        assert_eq!(status.snapshot().queue_depth, 4);
        step(
            &mut sink, &queue, &status, &mut retry, &time, &time, &mut batch,
        );
        assert_eq!(sink.received.len(), 2);
        assert!(sink.received.iter().all(|bytes| bytes.len() == 4 * 1048));
        assert_eq!(status.snapshot().packets, 8);
        assert_eq!(status.snapshot().reconnects, 1);
    }

    #[test]
    fn retained_audio_is_sent_after_a_network_delay() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut retry = Retry::new();
        let mut sink = sink(&time);
        let waiting = packet();
        time.delay_ms(500);
        send_batch(
            &mut sink,
            waiting.as_bytes(),
            1,
            PAYLOAD_BYTES,
            &status,
            &mut retry,
            &time,
        );
        assert_eq!(sink.calls, 1);
        assert_eq!(sink.writes, 1);
        assert_eq!(status.snapshot().packets, 1);
        assert_eq!(status.snapshot().sequence, 0);
    }

    #[test]
    fn connection_setup_preserves_the_waiting_packet() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut retry = Retry::new();
        let mut sink = sink(&time);
        sink.connect_ms = 2_000;
        send_batch(
            &mut sink,
            packet().as_bytes(),
            1,
            PAYLOAD_BYTES,
            &status,
            &mut retry,
            &time,
        );
        assert_eq!(sink.calls, 1);
        assert_eq!(sink.writes, 1);
        assert_eq!(status.snapshot().packets, 1);
    }

    #[test]
    fn control_changes_during_connection_setup_cancel_the_write() {
        for quiesce in [false, true] {
            let time = Time::default();
            let status = StreamStatus::default();
            let mut retry = Retry::new();
            status.mark_transport_present();
            let mut sink = sink(&time);
            sink.control = Some((&status, quiesce));
            send_batch(
                &mut sink,
                packet().as_bytes(),
                1,
                PAYLOAD_BYTES,
                &status,
                &mut retry,
                &time,
            );
            assert_eq!(sink.writes, 0);
            assert!(!status.transport_quiesced());
        }
    }

    #[test]
    fn failed_packets_are_not_replayed_after_backoff() {
        for secure in [false, true] {
            let time = Time::default();
            let status = StreamStatus::default();
            let mut retry = Retry::new();
            status.mark_transport_present();
            let mut sink = sink(&time);
            sink.failure = Some(secure);
            send_batch(
                &mut sink,
                packet().as_bytes(),
                1,
                PAYLOAD_BYTES,
                &status,
                &mut retry,
                &time,
            );
            assert_eq!(sink.calls, 1);
            assert_eq!(status.snapshot().network_errors, 1);
            assert_eq!(status.snapshot().tls_handshake_failures, u64::from(secure));
            assert!(!status.transport_quiesced());
            assert_eq!(retry.wait_ms(time.monotonic_millis()), 250);
        }
    }

    #[test]
    fn successful_sends_account_payload_reconnects_and_stalls() {
        let time = Time::default();
        let status = StreamStatus::default();
        let mut retry = Retry::new();
        let mut sink = sink(&time);
        send_batch(
            &mut sink,
            packet().as_bytes(),
            1,
            PAYLOAD_BYTES,
            &status,
            &mut retry,
            &time,
        );
        assert_eq!(status.snapshot().reconnects, 0);
        sink.write_ms = SEND_STALL_MS as u32;
        send_batch(
            &mut sink,
            packet().as_bytes(),
            1,
            PAYLOAD_BYTES,
            &status,
            &mut retry,
            &time,
        );
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
            let mut retry = Retry::new();
            status.mark_transport_present();
            let queue = PacketQueue::new();
            queue.push_drop_oldest(packet());
            if quiesce {
                status.request_transport_quiesce();
            } else {
                status.set_streaming_enabled(false);
            }
            let mut sink = sink(&time);
            let mut batch = Vec::with_capacity(MAX_BATCH_BYTES);
            step(
                &mut sink, &queue, &status, &mut retry, &time, &time, &mut batch,
            );
            assert_eq!(sink.calls, 0);
            assert_eq!(sink.disconnects, 1);
            assert_eq!(batch.capacity(), 0);
            assert!(queue.pop_timeout(Duration::ZERO).is_none());
            assert_eq!(status.transport_quiesced(), quiesce);
            status.end_transport_quiesce();
            status.set_streaming_enabled(true);
            step(
                &mut sink, &queue, &status, &mut retry, &time, &time, &mut batch,
            );
            queue.push_drop_oldest(packet());
            step(
                &mut sink, &queue, &status, &mut retry, &time, &time, &mut batch,
            );
            assert_eq!(sink.writes, 1);
        }
    }

    /// Step with a fresh packet queued each time until a batch is delivered or
    /// `until_ms` passes, returning when each send was attempted.
    fn attempt_times(
        sink: &mut Sink<'_>,
        queue: &PacketQueue<AudioPacket>,
        status: &StreamStatus,
        retry: &mut Retry,
        time: &Time,
        until_ms: u64,
    ) -> Vec<u64> {
        let writes = sink.writes;
        let mut attempts = Vec::new();
        let mut batch = Vec::new();
        while time.monotonic_millis() < until_ms && sink.writes == writes {
            queue.push_drop_oldest(packet());
            let calls = sink.calls;
            step(sink, queue, status, retry, time, time, &mut batch);
            if sink.calls > calls {
                attempts.push(time.monotonic_millis());
            }
        }
        attempts
    }

    #[test]
    fn an_unreachable_bridge_is_retried_at_doubling_intervals_up_to_thirty_seconds() {
        let time = Time::default();
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut retry = Retry::new();
        let mut sink = sink(&time);
        sink.failure = Some(false);
        let attempts = attempt_times(&mut sink, &queue, &status, &mut retry, &time, 120_000);
        let gaps: Vec<u64> = attempts.windows(2).map(|pair| pair[1] - pair[0]).collect();
        assert_eq!(
            gaps,
            [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
        );
        assert_eq!(status.snapshot().network_errors, 10);

        sink.failure = None;
        let back_at = time.monotonic_millis();
        let attempts = attempt_times(
            &mut sink,
            &queue,
            &status,
            &mut retry,
            &time,
            back_at + 60_000,
        );
        assert_eq!(attempts.len(), 1);
        assert!(attempts[0] - back_at <= 30_000);
        assert_eq!(sink.writes, 1);
        assert_eq!(retry.wait_ms(time.monotonic_millis()), 0);
    }

    #[test]
    fn a_pause_during_a_retry_wait_applies_at_once_and_resumes_without_waiting() {
        for quiesce in [false, true] {
            let time = Time::default();
            let status = StreamStatus::default();
            status.mark_transport_present();
            let queue = PacketQueue::new();
            let mut retry = Retry::new();
            let mut sink = sink(&time);
            sink.failure = Some(false);
            attempt_times(&mut sink, &queue, &status, &mut retry, &time, 20_000);
            assert!(retry.wait_ms(time.monotonic_millis()) > 1_000);
            if quiesce {
                status.request_transport_quiesce();
            } else {
                status.set_streaming_enabled(false);
            }
            let paused_at = time.monotonic_millis();
            step(
                &mut sink,
                &queue,
                &status,
                &mut retry,
                &time,
                &time,
                &mut Vec::new(),
            );
            assert_eq!(status.transport_quiesced(), quiesce);
            assert_eq!(sink.disconnects, 1);
            assert!(time.monotonic_millis() - paused_at <= u64::from(CONTROL_POLL_MS));

            status.end_transport_quiesce();
            status.set_streaming_enabled(true);
            sink.failure = None;
            let resumed_at = time.monotonic_millis();
            let attempts = attempt_times(
                &mut sink,
                &queue,
                &status,
                &mut retry,
                &time,
                resumed_at + 10_000,
            );
            assert_eq!(attempts, [resumed_at]);
            assert_eq!(sink.writes, 1);
        }
    }

    #[test]
    fn a_resume_the_heap_cannot_hold_retries_on_the_schedule_until_memory_returns() {
        use crate::fragmented_heap::with_largest_block;

        let time = Time::default();
        let status = StreamStatus::default();
        status.mark_transport_present();
        let queue = PacketQueue::new();
        let mut retry = Retry::new();
        let mut sink = sink(&time);
        status.request_transport_quiesce();
        step(
            &mut sink,
            &queue,
            &status,
            &mut retry,
            &time,
            &time,
            &mut Vec::new(),
        );
        status.end_transport_quiesce();

        // Reserves fail at 100, 350, 850 and 1,850 ms; memory returns before the next.
        with_largest_block(8_192, || {
            while time.monotonic_millis() < 2_000 {
                step(
                    &mut sink,
                    &queue,
                    &status,
                    &mut retry,
                    &time,
                    &time,
                    &mut Vec::new(),
                );
            }
        });
        assert_eq!(sink.calls, 0);
        assert!(!status.restart_needed());
        assert_eq!(queue.push_drop_oldest(packet()), (false, 0));

        let attempts = attempt_times(&mut sink, &queue, &status, &mut retry, &time, 10_000);
        assert_eq!(attempts, [3_850]);
        assert_eq!(sink.writes, 1);
    }

    #[test]
    fn a_heap_that_refuses_the_queue_for_a_minute_asks_for_a_restart_until_it_recovers() {
        use crate::fragmented_heap::with_largest_block;

        let time = Time::default();
        let status = StreamStatus::default();
        status.mark_transport_present();
        let queue = PacketQueue::new();
        let mut retry = Retry::new();
        let mut sink = sink(&time);
        status.request_transport_quiesce();
        step(
            &mut sink,
            &queue,
            &status,
            &mut retry,
            &time,
            &time,
            &mut Vec::new(),
        );
        status.end_transport_quiesce();
        with_largest_block(8_192, || {
            while time.monotonic_millis() < 62_000 {
                step(
                    &mut sink,
                    &queue,
                    &status,
                    &mut retry,
                    &time,
                    &time,
                    &mut Vec::new(),
                );
            }
        });
        assert!(status.restart_needed());

        let attempts = attempt_times(&mut sink, &queue, &status, &mut retry, &time, 200_000);
        assert_eq!(attempts.len(), 1);
        assert!(!status.restart_needed());
    }

    /// A bridge that accepts each connection and closes it after the first write.
    struct ClosingBridge {
        time: Time,
        writes_on_connection: usize,
        connections: Vec<u64>,
    }
    impl PacketSink for ClosingBridge {
        fn send(
            &mut self,
            _bytes: &[u8],
            ready: impl FnOnce() -> bool,
        ) -> Result<Option<bool>, SendFailed> {
            let new_connection = self.writes_on_connection == 0;
            if new_connection {
                self.connections.push(self.time.monotonic_millis());
            }
            if !ready() {
                return Ok(None);
            }
            self.writes_on_connection += 1;
            if self.writes_on_connection > 1 {
                self.writes_on_connection = 0;
                return Err(SendFailed {
                    secure_handshake: false,
                    cause: "connection reset".into(),
                });
            }
            Ok(Some(new_connection))
        }
        fn disconnect(&mut self) {
            self.writes_on_connection = 0;
        }
    }

    #[test]
    fn a_bridge_that_closes_each_accepted_connection_stays_on_the_backoff_schedule() {
        let time = Time::default();
        let status = StreamStatus::default();
        let queue = PacketQueue::new();
        let mut retry = Retry::new();
        let mut bridge = ClosingBridge {
            time: time.clone(),
            writes_on_connection: 0,
            connections: Vec::new(),
        };
        let mut batch = Vec::new();
        while time.monotonic_millis() < 120_000 {
            for _ in 0..4 {
                queue.push_drop_oldest(packet());
            }
            step(
                &mut bridge,
                &queue,
                &status,
                &mut retry,
                &time,
                &time,
                &mut batch,
            );
        }
        let gaps: Vec<u64> = bridge
            .connections
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect();
        assert_eq!(
            gaps,
            [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]
        );
    }
}
