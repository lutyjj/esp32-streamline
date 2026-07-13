//! Network policy: drain the queue and retry each packet until it lands,
//! accounting reconnects, errors, and TLS handshake failures.

use std::sync::Arc;

use crate::packet::AudioPacket;

use super::{
    effects::{Delay, PacketSink},
    queue::PacketQueue,
    status::StreamStatus,
};

/// Back off this long after a send failure before retrying the same target.
const SEND_ERROR_BACKOFF_MS: u32 = 250;

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

/// Retry one packet until it lands, so a brief network stall never drops audio
/// the queue still holds.
fn send_packet(
    sink: &mut impl PacketSink,
    packet: &AudioPacket,
    status: &StreamStatus,
    delay: &impl Delay,
) {
    loop {
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

    use super::{send_packet, SEND_ERROR_BACKOFF_MS};
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
        AudioPacket::from_pcm(0, &[0_u8; PAYLOAD_BYTES]).expect("valid packet")
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
