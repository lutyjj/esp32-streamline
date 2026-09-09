//! The concrete effects the pipeline engines depend on.
//!
//! Adapters implement these at the device edge — I2S capture, the TCP sender,
//! FreeRTOS delays — and report their own failures. The engines decide policy
//! only, so the same code runs against fakes in host tests.

/// A source read failed. The source has already reported the cause.
pub struct ReadFailed;

/// A packet send failed. The sink has already reported the cause; the flag lets
/// the pipeline count TLS handshake rejections apart from ordinary I/O errors.
pub struct SendFailed {
    pub secure_handshake: bool,
}

/// Captured PCM bytes, filled from the I2S input.
pub trait PcmSource {
    /// Fill the start of `buffer` and return the byte count. A read may return
    /// fewer bytes than the buffer holds, including zero; the capture engine
    /// owns coalescing them into whole packets. Each driver wait is bounded by `timeout_ms`. A failure returns
    /// [`ReadFailed`].
    fn read(&mut self, buffer: &mut [u8], timeout_ms: u32) -> Result<usize, ReadFailed>;
}

/// One framed packet sent over the transport selected at boot.
pub trait PacketSink {
    /// Send one packet. `Ok(Some(true))` reports a freshly established connection, so
    /// the pipeline can count reconnects; `Err` reports a failed send.
    /// `ready` is checked after connection setup, before any packet bytes are written.
    /// `Ok(None)` retains the connection without sending the rejected packet.
    fn send(
        &mut self,
        bytes: &[u8],
        ready: impl FnOnce() -> bool,
    ) -> Result<Option<bool>, SendFailed>;

    /// Close any open connection, freeing its socket and TLS buffers. The next
    /// send reconnects.
    fn disconnect(&mut self);
}

/// A blocking delay used to back off after a failure.
pub trait Delay {
    fn delay_ms(&self, millis: u32);
}

/// Shared monotonic time for capture timestamps and transport deadlines.
pub trait Clock {
    fn monotonic_millis(&self) -> u64;
}
