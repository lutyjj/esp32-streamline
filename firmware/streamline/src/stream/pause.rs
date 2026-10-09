//! Release transport resources for exclusive firmware maintenance.

use super::StreamStatus;

const POLL_MS: u32 = 100;
const TIMEOUT_MS: u32 = 10_000;

/// Resumes transport admission when maintenance returns, including on failure.
pub struct TransportPause<'a>(&'a StreamStatus);

impl Drop for TransportPause<'_> {
    fn drop(&mut self) {
        self.0.end_transport_quiesce();
    }
}

/// Wait for the sender to close its connection before allocating maintenance
/// resources. Dropping the returned guard preserves the user's enabled state.
pub fn pause_transport(
    status: &StreamStatus,
    mut wait_ms: impl FnMut(u32),
) -> Result<TransportPause<'_>, &'static str> {
    let pause = TransportPause(status);
    status.request_transport_quiesce();
    for _ in 0..TIMEOUT_MS / POLL_MS {
        if status.transport_quiesced() {
            return Ok(pause);
        }
        wait_ms(POLL_MS);
    }
    Err("audio streaming did not pause in time")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_waits_for_release_and_resumes_on_return() {
        let status = StreamStatus::default();
        status.mark_transport_present();
        let mut polls = 0;
        let pause = pause_transport(&status, |_| {
            assert!(status.transport_quiesce_requested());
            polls += 1;
            if polls == 2 {
                status.acknowledge_transport_quiesced();
            }
        })
        .ok()
        .unwrap();
        assert_eq!(polls, 2);
        assert!(status.transport_quiesced());
        drop(pause);
        assert!(!status.transport_quiesce_requested());
        assert!(status.streaming_enabled());
    }

    #[test]
    fn timeout_releases_the_request_without_admitting_maintenance() {
        let status = StreamStatus::default();
        status.mark_transport_present();
        let mut waited = 0;
        assert!(pause_transport(&status, |millis| waited += millis).is_err());
        assert_eq!(waited, TIMEOUT_MS);
        assert!(!status.transport_quiesce_requested());
    }

    #[test]
    fn no_sender_needs_no_wait_and_does_not_enable_paused_streaming() {
        let status = StreamStatus::default();
        status.set_streaming_enabled(false);
        let pause = pause_transport(&status, |_| panic!("no sender to wait for"))
            .ok()
            .unwrap();
        drop(pause);
        assert!(!status.streaming_enabled());
        assert!(!status.transport_quiesce_requested());
    }
}
