//! Bounded, resettable telemetry for one stream reporting window.

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StreamCounters {
    pub packets: u32,
    pub payload_bytes: u32,
    pub queue_drops: u32,
    pub network_errors: u32,
    pub reconnects: u32,
}

impl StreamCounters {
    pub fn record_packet(&mut self, payload_bytes: usize) {
        self.packets = self.packets.saturating_add(1);
        self.payload_bytes = self.payload_bytes.saturating_add(payload_bytes as u32);
    }

    pub fn clear_window(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::StreamCounters;

    #[test]
    fn clears_only_the_reporting_window() {
        let mut counters = StreamCounters::default();
        counters.record_packet(1024);
        counters.queue_drops = 1;

        counters.clear_window();

        assert_eq!(counters, StreamCounters::default());
    }
}
