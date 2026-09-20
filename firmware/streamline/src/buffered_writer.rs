//! Buffered output with inline storage and explicit flushing.

use std::io::{self, Write};

pub(crate) struct BufferedWriter<W, const N: usize> {
    inner: W,
    buffer: [u8; N],
    start: usize,
    end: usize,
}

impl<W: Write, const N: usize> BufferedWriter<W, N> {
    pub(crate) fn new(inner: W) -> Self {
        assert!(N > 0);
        Self {
            inner,
            buffer: [0; N],
            start: 0,
            end: 0,
        }
    }

    fn drain(&mut self) -> io::Result<()> {
        while self.start < self.end {
            match self.inner.write(&self.buffer[self.start..self.end]) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(written) => self.start += written,
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }
        self.start = 0;
        self.end = 0;
        Ok(())
    }
}

impl<W: Write, const N: usize> Write for BufferedWriter<W, N> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > N - self.end {
            self.drain()?;
        }
        if bytes.len() >= N {
            return self.inner.write(bytes);
        }
        self.buffer[self.end..self.end + bytes.len()].copy_from_slice(bytes);
        self.end += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.drain()?;
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_streams_across_buffers_and_flushes_the_tail() {
        let value = ["short", "a string longer than the buffer", "\"escaped\""];
        let mut output = Vec::new();
        let mut writer = BufferedWriter::<_, 8>::new(&mut output);
        serde_json::to_writer(&mut writer, &value).unwrap();
        writer.flush().unwrap();
        assert_eq!(output, serde_json::to_vec(&value).unwrap());
    }

    #[test]
    fn retries_preserve_only_the_unwritten_bytes() {
        let sink = std::io::Cursor::new([0_u8; 2]);
        let mut writer = BufferedWriter::<_, 8>::new(sink);
        writer.write_all(b"abcd").unwrap();
        assert_eq!(writer.flush().unwrap_err().kind(), io::ErrorKind::WriteZero);
        assert_eq!(writer.inner.get_ref(), b"ab");
        writer.inner.set_position(0);
        writer.flush().unwrap();
        assert_eq!(writer.inner.get_ref(), b"cd");
    }

    #[test]
    fn interrupted_and_short_writes_preserve_the_body() {
        let mut output = Vec::new();
        let mut calls = 0;
        struct InterruptedOnce<'a>(&'a mut usize, &'a mut Vec<u8>);
        impl Write for InterruptedOnce<'_> {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                *self.0 += 1;
                if *self.0 == 1 {
                    return Err(io::ErrorKind::Interrupted.into());
                }
                self.1.write(&bytes[..1])
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut writer = BufferedWriter::<_, 8>::new(InterruptedOnce(&mut calls, &mut output));
        writer.write_all(b"abcd").unwrap();
        writer.flush().unwrap();
        assert_eq!(output, b"abcd");
    }
}
