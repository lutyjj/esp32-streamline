//! Network policy: drain the queue and retry each packet while it stays
//! fresh, accounting reconnects, errors, TLS handshake failures, and stale
//! drops.

use std::sync::Arc;

use crate::packet::AudioPacket;

use super::{
    effects::{Delay, PacketSink},
    queue::{PacketQueue, QUEUE_DEPTH},
    status::StreamStatus,
};

/// Back off this long after a send failure before retrying the same target.
const SEND_ERROR_BACKOFF_MS: u32 = 250;

/// Retry a packet only while it is at most this many packets behind the
/// capture sequence: the same latency bound the drop-oldest queue enforces.
/// Past it the packet is stale audio, and a reconnect must resume from
/// current samples instead of replaying the outage.
const MAX_IN_FLIGHT_AGE_PACKETS: u32 = QUEUE_DEPTH as u32;

/// Drain the queue forever, sending each packet in order.
pub fn run(
    mut sink: impl PacketSink,
    queue: Arc<PacketQueue<AudioPacket>>,
    status: Arc<StreamStatus>,
    delay: impl Delay,
) -> ! {
    loop {
        let (packet, depth) = queue.pop();
        status.set_queue_depth(depth);
        send_packet(&mut sink, &packet, &status, &delay);
    }
}

/// Retry one packet while it stays within the latency bound, so a brief
/// network stall never drops audio but a long outage never replays it. The
/// capture sequence keeps advancing through idle input and sustained stalls,
/// so packet age tracks wall time even when nothing else is enqueued.
fn send_packet(
    sink: &mut impl PacketSink,
    packet: &AudioPacket,
    status: &StreamStatus,
    delay: &impl Delay,
) {
    loop {
        if status.sequence().wrapping_sub(packet.sequence()) > MAX_IN_FLIGHT_AGE_PACKETS {
            status.record_stale_drop();
            return;
        }
        match sink.send(packet.as_bytes()) {
            Ok(reconnected) => {
                status.record_sent(packet.payload_bytes(), reconnected);
                return;
            }
            Err(failure) => {
                status.record_network_error(failure.secure_handshake);
                delay.delay_ms(SEND_ERROR_BACKOFF_MS);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::VecDeque};

    use super::{send_packet, MAX_IN_FLIGHT_AGE_PACKETS, SEND_ERROR_BACKOFF_MS};
    use crate::{
        packet::AudioPacket,
        protocol::PAYLOAD_BYTES,
        stream::{
            effects::{Delay, PacketSink, SendFailed},
            status::StreamStatus,
        },
    };

    struct FakeSink {
        results: VecDeque<Result<bool, SendFailed>>,
    }

    impl PacketSink for FakeSink {
        fn send(&mut self, _bytes: &[u8]) -> Result<bool, SendFailed> {
            self.results.pop_front().expect("no more scripted sends")
        }
    }

    #[derive(Default)]
    struct RecordingDelay {
        waits: RefCell<Vec<u32>>,
    }

    impl Delay for RecordingDelay {
        fn delay_ms(&self, millis: u32) {
            self.waits.borrow_mut().push(millis);
        }
    }

    fn packet() -> AudioPacket {
        AudioPacket::from_pcm(0, &[0_u8; PAYLOAD_BYTES])
    }

    fn io_error() -> Result<bool, SendFailed> {
        Err(SendFailed {
            secure_handshake: false,
        })
    }

    #[test]
    fn the_first_connect_is_not_counted_as_a_reconnect() {
        let status = StreamStatus::default();
        let mut sink = FakeSink {
            results: VecDeque::from([Ok(true)]),
        };

        send_packet(&mut sink, &packet(), &status, &RecordingDelay::default());

        let snapshot = status.snapshot();
        assert_eq!(snapshot.packets, 1);
        assert_eq!(snapshot.bytes, PAYLOAD_BYTES as u64);
        assert_eq!(snapshot.reconnects, 0);
    }

    #[test]
    fn send_failures_retry_with_backoff_and_a_later_reconnect_is_counted() {
        let status = StreamStatus::default();
        let delay = RecordingDelay::default();

        // The first packet lands on the initial connection.
        send_packet(
            &mut FakeSink {
                results: VecDeque::from([Ok(true)]),
            },
            &packet(),
            &status,
            &delay,
        );
        // The second fails twice, backs off after each, then reconnects.
        send_packet(
            &mut FakeSink {
                results: VecDeque::from([io_error(), io_error(), Ok(true)]),
            },
            &packet(),
            &status,
            &delay,
        );

        let snapshot = status.snapshot();
        assert_eq!(snapshot.packets, 2);
        assert_eq!(snapshot.network_errors, 2);
        assert_eq!(snapshot.reconnects, 1);
        assert_eq!(snapshot.tls_handshake_failures, 0);
        assert_eq!(delay.waits.into_inner(), vec![SEND_ERROR_BACKOFF_MS; 2]);
    }

    #[test]
    fn a_stale_packet_is_dropped_without_a_send_attempt() {
        let status = StreamStatus::default();
        for _ in 0..MAX_IN_FLIGHT_AGE_PACKETS + 2 {
            status.next_sequence();
        }
        // An empty script panics on any send, proving none was attempted.
        let mut sink = FakeSink {
            results: VecDeque::new(),
        };

        send_packet(&mut sink, &packet(), &status, &RecordingDelay::default());

        let snapshot = status.snapshot();
        assert_eq!(snapshot.stale_drops, 1);
        assert_eq!(snapshot.packets, 0);
        assert_eq!(snapshot.network_errors, 0);
    }

    /// Fails every send and advances the capture sequence as a side effect,
    /// modeling wall time passing while the transport is down.
    struct FailingAdvancingSink<'a> {
        status: &'a StreamStatus,
        advance_per_send: u32,
    }

    impl PacketSink for FailingAdvancingSink<'_> {
        fn send(&mut self, _bytes: &[u8]) -> Result<bool, SendFailed> {
            for _ in 0..self.advance_per_send {
                self.status.next_sequence();
            }
            Err(SendFailed {
                secure_handshake: false,
            })
        }
    }

    #[test]
    fn a_packet_that_ages_past_the_bound_mid_retry_is_dropped() {
        let status = StreamStatus::default();
        let delay = RecordingDelay::default();
        let mut sink = FailingAdvancingSink {
            status: &status,
            advance_per_send: 20,
        };

        send_packet(&mut sink, &packet(), &status, &delay);

        let snapshot = status.snapshot();
        // Ages 0 and 20 retried; at 40 the packet crossed the 32-packet
        // bound and was dropped instead of replayed.
        assert_eq!(snapshot.network_errors, 2);
        assert_eq!(snapshot.stale_drops, 1);
        assert_eq!(snapshot.packets, 0);
        assert_eq!(delay.waits.into_inner(), vec![SEND_ERROR_BACKOFF_MS; 2]);
    }

    #[test]
    fn tls_handshake_failures_are_counted_apart_from_io_errors() {
        let status = StreamStatus::default();
        let mut sink = FakeSink {
            results: VecDeque::from([
                Err(SendFailed {
                    secure_handshake: true,
                }),
                Ok(false),
            ]),
        };

        send_packet(&mut sink, &packet(), &status, &RecordingDelay::default());

        let snapshot = status.snapshot();
        assert_eq!(snapshot.network_errors, 1);
        assert_eq!(snapshot.tls_handshake_failures, 1);
        assert_eq!(snapshot.packets, 1);
        assert_eq!(snapshot.reconnects, 0);
    }
}
