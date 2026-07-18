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
    /// owns coalescing them into whole packets. A failure returns
    /// [`ReadFailed`].
    fn read(&mut self, buffer: &mut [u8]) -> Result<usize, ReadFailed>;
}

/// One framed packet sent over the transport selected at boot.
pub trait PacketSink {
    /// Send one packet. `Ok(true)` reports a freshly established connection, so
    /// the pipeline can count reconnects; `Err` reports a failure to retry.
    fn send(&mut self, bytes: &[u8]) -> Result<bool, SendFailed>;
}

/// A blocking delay used to back off after a failure.
pub trait Delay {
    fn delay_ms(&self, millis: u32);
}
