//! Bounded capture of the device's most recent log lines.
//!
//! The buffer is plain data with a stable layout so an adapter can place one
//! instance in memory that a software reset does not clear: after a panic the
//! lines leading up to it are still readable. Every decision about what a line
//! is — splitting a chunk, stripping terminal escapes, truncating, evicting the
//! oldest — lives here rather than in the adapter, so it is host-testable.
//!
//! Sequence numbers count lines within one boot. A reader that polls compares
//! them to tell new lines from lines it already has, and a gap against
//! [`LogRing::dropped`] tells it how much the buffer discarded in between.

/// Bytes kept for one line. Longer lines are truncated rather than dropped: a
/// long line is usually a formatted error whose beginning carries the fact.
pub const MAX_LINE_BYTES: usize = 240;

/// Marks a buffer this build wrote and can read back. The value changes with
/// the struct layout, so an image that reboots into a different layout treats
/// what it finds as absent rather than misreading it.
const LAYOUT_TAG: u32 = 0x4C4F_4731;

/// A line held in the buffer, with the sequence number it was given.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LogLine<'a> {
    pub sequence: u64,
    pub bytes: &'a [u8],
}

impl LogLine<'_> {
    /// The line as text. Sanitizing keeps printable ASCII and any byte a
    /// UTF-8 sequence could use, so replacement only appears for a line the
    /// buffer received already malformed.
    pub fn text(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(self.bytes)
    }
}

/// A fixed-capacity buffer of whole log lines, oldest evicted first.
///
/// `N` is the byte capacity of the line storage. The representation is `repr(C)`
/// because an instance can outlive the image that wrote it, so field order must
/// not move between builds; [`LAYOUT_TAG`] covers the rest.
#[repr(C)]
pub struct LogRing<const N: usize> {
    layout: u32,
    filled: u32,
    next_sequence: u64,
    dropped: u64,
    bytes: [u8; N],
}

impl<const N: usize> Default for LogRing<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> LogRing<N> {
    /// Eviction frees this many bytes at once so it runs about once per
    /// quarter-buffer instead of on nearly every line.
    const EVICTION_BYTES: usize = N / 4;

    /// Capacity has to hold several maximum-length lines for eviction to be a
    /// meaningful operation rather than a buffer-clearing one.
    const CAPACITY_IS_SUFFICIENT: () = assert!(N > MAX_LINE_BYTES * 4);

    /// An empty buffer that reads as absent until [`LogRing::reset`] stamps it.
    /// Every field is zero so a static costs no image bytes, and a region that
    /// was never written reads as absent rather than as an empty log.
    pub const fn new() -> Self {
        Self {
            layout: 0,
            filled: 0,
            next_sequence: 0,
            dropped: 0,
            bytes: [0; N],
        }
    }

    /// Claim the buffer for this boot: stamp the layout and start empty.
    pub fn reset(&mut self) {
        let () = Self::CAPACITY_IS_SUFFICIENT;
        self.layout = LAYOUT_TAG;
        self.filled = 0;
        self.next_sequence = 0;
        self.dropped = 0;
    }

    /// Whether the buffer holds lines this build wrote and can trust. Memory
    /// that survived a reset is validated, never assumed.
    pub fn is_intact(&self) -> bool {
        self.layout == LAYOUT_TAG
            && self.filled as usize <= N
            && self.next_sequence >= self.stored_line_count() as u64
    }

    /// Add one chunk of log output. A chunk carrying several newline-separated
    /// lines becomes several lines, and a chunk with no newline becomes one, so
    /// the buffer holds whole lines whatever the caller's framing.
    pub fn append(&mut self, chunk: &[u8]) {
        for line in chunk.split(|byte| *byte == b'\n') {
            self.append_line(line);
        }
    }

    /// Lines held now, oldest first.
    pub fn lines(&self) -> impl Iterator<Item = LogLine<'_>> {
        let first = self
            .next_sequence
            .saturating_sub(self.stored_line_count() as u64);
        self.stored()
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
            .enumerate()
            .map(move |(offset, bytes)| LogLine {
                sequence: first + offset as u64,
                bytes,
            })
    }

    /// Lines discarded to make room since this boot claimed the buffer.
    pub const fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Copy the contents into `destination`, which need not have the same
    /// capacity: the boot snapshot keeps the previous boot's lines without a
    /// second buffer of live size.
    pub fn copy_into<const M: usize>(&self, destination: &mut LogRing<M>) {
        destination.reset();
        for line in self.lines() {
            destination.append_line(line.bytes);
        }
        // Appending re-derived the sequence numbers from zero and counted what
        // a smaller destination could not hold; restore the source's numbering
        // and carry the losses from both buffers.
        destination.next_sequence = self.next_sequence;
        destination.dropped += self.dropped;
    }

    fn append_line(&mut self, raw: &[u8]) {
        let mut line = [0u8; MAX_LINE_BYTES];
        let length = sanitize(raw, &mut line);
        if length == 0 {
            return;
        }
        while self.filled as usize + length + 1 > N {
            self.evict();
        }
        let start = self.filled as usize;
        self.bytes[start..start + length].copy_from_slice(&line[..length]);
        self.bytes[start + length] = b'\n';
        self.filled += length as u32 + 1;
        self.next_sequence += 1;
    }

    /// Drop whole lines from the front until [`Self::EVICTION_BYTES`] are free.
    fn evict(&mut self) {
        let filled = self.filled as usize;
        let keep_below = N.saturating_sub(Self::EVICTION_BYTES.max(1));
        let mut cut = 0;
        while filled - cut > keep_below {
            match self.bytes[cut..filled]
                .iter()
                .position(|byte| *byte == b'\n')
            {
                Some(offset) => cut += offset + 1,
                // Unreachable while every stored line carries its terminator;
                // clearing keeps a corrupt buffer from looping here.
                None => cut = filled,
            }
            self.dropped += 1;
        }
        self.bytes.copy_within(cut..filled, 0);
        self.filled = (filled - cut) as u32;
    }

    fn stored(&self) -> &[u8] {
        &self.bytes[..(self.filled as usize).min(N)]
    }

    fn stored_line_count(&self) -> usize {
        self.stored().iter().filter(|byte| **byte == b'\n').count()
    }
}

/// Copy `raw` into `line` keeping only what a reader can use: terminal escape
/// sequences and control characters are removed, and the result is truncated to
/// the line budget. Returns the number of bytes written.
///
/// ESP-IDF wraps log lines in ANSI color when `CONFIG_LOG_COLORS` is on. Those
/// escapes are noise in JSON and in a browser, and stripping them here keeps
/// every reader from having to.
fn sanitize(raw: &[u8], line: &mut [u8; MAX_LINE_BYTES]) -> usize {
    let mut length = 0;
    let mut remaining = raw;
    while let Some((byte, rest)) = remaining.split_first() {
        remaining = rest;
        if *byte == 0x1b {
            // CSI: ESC '[' parameters, ended by a byte in 0x40..=0x7e.
            if let Some((b'[', parameters)) = remaining.split_first() {
                let end = parameters
                    .iter()
                    .position(|byte| (0x40..=0x7e).contains(byte));
                remaining = match end {
                    Some(offset) => &parameters[offset + 1..],
                    None => &[],
                };
            }
            continue;
        }
        if byte.is_ascii_control() {
            continue;
        }
        if length == MAX_LINE_BYTES {
            break;
        }
        line[length] = *byte;
        length += 1;
    }
    while length > 0 && line[length - 1] == b' ' {
        length -= 1;
    }
    length
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPACITY: usize = MAX_LINE_BYTES * 8;
    /// Enough short lines to overflow [`CAPACITY`] several times over.
    const OVERFLOWING_LINES: u64 = 400;

    fn texts<const N: usize>(ring: &LogRing<N>) -> Vec<String> {
        ring.lines().map(|line| line.text().into_owned()).collect()
    }

    fn sequences<const N: usize>(ring: &LogRing<N>) -> Vec<u64> {
        ring.lines().map(|line| line.sequence).collect()
    }

    fn started() -> LogRing<CAPACITY> {
        let mut ring = LogRing::new();
        ring.reset();
        ring
    }

    #[test]
    fn a_fresh_buffer_reads_as_absent() {
        let ring: LogRing<CAPACITY> = LogRing::new();
        assert!(!ring.is_intact());
        assert_eq!(texts(&ring), Vec::<String>::new());
    }

    #[test]
    fn reset_claims_the_buffer() {
        let ring = started();
        assert!(ring.is_intact());
        assert_eq!(ring.dropped(), 0);
    }

    #[test]
    fn appended_lines_come_back_in_order_with_sequences_from_zero() {
        let mut ring = started();
        ring.append(b"first\n");
        ring.append(b"second\n");
        assert_eq!(texts(&ring), vec!["first", "second"]);
        assert_eq!(sequences(&ring), vec![0, 1]);
    }

    #[test]
    fn one_chunk_carrying_several_lines_becomes_several_lines() {
        let mut ring = started();
        ring.append(b"first\nsecond\nthird\n");
        assert_eq!(texts(&ring), vec!["first", "second", "third"]);
        assert_eq!(sequences(&ring), vec![0, 1, 2]);
    }

    #[test]
    fn a_chunk_without_a_terminator_is_still_one_line() {
        let mut ring = started();
        ring.append(b"unterminated");
        assert_eq!(texts(&ring), vec!["unterminated"]);
    }

    #[test]
    fn blank_lines_are_not_stored() {
        let mut ring = started();
        ring.append(b"\n\n   \nreal\n");
        assert_eq!(texts(&ring), vec!["real"]);
        assert_eq!(sequences(&ring), vec![0]);
    }

    #[test]
    fn terminal_color_escapes_are_stripped() {
        let mut ring = started();
        ring.append(b"\x1b[0;32mI (123) wifi: connected\x1b[0m\n");
        assert_eq!(texts(&ring), vec!["I (123) wifi: connected"]);
    }

    #[test]
    fn an_unterminated_escape_does_not_leak_into_the_line() {
        let mut ring = started();
        ring.append(b"before\x1b[0;32");
        assert_eq!(texts(&ring), vec!["before"]);
    }

    #[test]
    fn a_long_line_is_truncated_not_dropped() {
        let mut ring = started();
        let long = "x".repeat(MAX_LINE_BYTES * 2);
        ring.append(long.as_bytes());
        assert_eq!(texts(&ring), vec!["x".repeat(MAX_LINE_BYTES)]);
    }

    #[test]
    fn eviction_drops_whole_lines_and_counts_them() {
        let mut ring = started();
        for index in 0..OVERFLOWING_LINES {
            ring.append(format!("line {index}\n").as_bytes());
        }
        let stored = texts(&ring);
        assert!(
            (stored.len() as u64) < OVERFLOWING_LINES,
            "the buffer should have evicted"
        );
        assert_eq!(ring.dropped(), OVERFLOWING_LINES - stored.len() as u64);
        assert_eq!(stored.last().unwrap(), "line 399");
        for line in &stored {
            assert!(line.starts_with("line "), "partial line stored: {line}");
        }
    }

    #[test]
    fn sequences_survive_eviction_so_a_reader_sees_the_gap() {
        let mut ring = started();
        for index in 0..OVERFLOWING_LINES {
            ring.append(format!("line {index}\n").as_bytes());
        }
        let sequences = sequences(&ring);
        assert_eq!(*sequences.last().unwrap(), OVERFLOWING_LINES - 1);
        assert_eq!(sequences[0], OVERFLOWING_LINES - sequences.len() as u64);
        assert!(sequences.windows(2).all(|pair| pair[1] == pair[0] + 1));
    }

    #[test]
    fn a_snapshot_keeps_the_newest_lines_and_reports_what_it_could_not_hold() {
        // Lines long enough that the whole run fits the live buffer but not a
        // snapshot a quarter smaller, so the copy has to evict.
        let mut live = started();
        for index in 0..40 {
            live.append(format!("line {index:02} {}\n", "x".repeat(30)).as_bytes());
        }
        assert_eq!(live.dropped(), 0, "the live buffer should still hold them");

        let mut snapshot: LogRing<{ MAX_LINE_BYTES * 5 }> = LogRing::new();
        live.copy_into(&mut snapshot);

        assert!(snapshot.is_intact());
        let kept = texts(&snapshot);
        assert!(kept.len() < 40, "the snapshot should have evicted");
        assert!(kept.last().unwrap().starts_with("line 39 "));
        assert_eq!(sequences(&snapshot).last(), Some(&39));
        assert_eq!(snapshot.dropped(), 40 - kept.len() as u64);
    }

    #[test]
    fn a_snapshot_that_fits_carries_the_whole_log_across_unchanged() {
        let mut live = started();
        for index in 0..10 {
            live.append(format!("line {index}\n").as_bytes());
        }
        let mut snapshot: LogRing<CAPACITY> = LogRing::new();
        live.copy_into(&mut snapshot);

        assert_eq!(texts(&snapshot), texts(&live));
        assert_eq!(sequences(&snapshot), sequences(&live));
        assert_eq!(snapshot.dropped(), 0);
    }

    #[test]
    fn a_buffer_from_another_layout_reads_as_absent() {
        let mut ring = started();
        ring.append(b"line\n");
        ring.layout = LAYOUT_TAG ^ 0xFFFF;
        assert!(!ring.is_intact());
    }

    #[test]
    fn an_impossible_length_reads_as_absent() {
        let mut ring = started();
        ring.filled = CAPACITY as u32 + 1;
        assert!(!ring.is_intact());
    }

    #[test]
    fn a_second_boot_starts_its_sequences_again() {
        let mut ring = started();
        ring.append(b"old\n");
        ring.reset();
        ring.append(b"new\n");
        assert_eq!(texts(&ring), vec!["new"]);
        assert_eq!(sequences(&ring), vec![0]);
    }
}
