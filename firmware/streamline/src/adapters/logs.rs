//! Capture of the device's own log output into memory the API can serve.
//!
//! ESP-IDF routes every log line — the firmware's and the Wi-Fi, esp-tls, and
//! OTA components' — through one `vprintf`-shaped hook. Installing that hook
//! puts each rendered line into a [`LogBuffer`] before it reaches the UART, so a
//! device with no serial cable attached can still be read.
//!
//! The current buffer sits in `.noinit`, which the linker excludes from startup
//! zeroing and the heap. A software reset — the kind a panic ends in — leaves
//! it intact, so the first thing [`install`] does is copy the previous boot's
//! lines aside. That is what turns "the device rebooted" into a readable
//! account of what it was doing beforehand.
//!
//! Allocation failures are captured the same way. The hook ESP-IDF calls when
//! an allocation cannot be satisfied runs before the abort that follows it, so
//! the requested size, the caller, and the heap that was left land in the
//! buffer and survive into the next boot.

use core::{
    ffi::{c_char, c_int, CStr},
    fmt::Write,
    ptr::addr_of_mut,
};
use std::sync::{Mutex, Once, OnceLock};

use esp_idf_svc::sys::{
    esp_get_free_heap_size, esp_log_set_vprintf, esp_random, esp_rom_printf,
    heap_caps_get_largest_free_block, heap_caps_register_failed_alloc_callback, va_list, ESP_OK,
};

use crate::logs::{LogBuffer, MAX_LINE_BYTES};

/// Capture size for the running boot. Holds a few minutes of ordinary boot and
/// streaming chatter, which is the window an operator polls; it is static, so
/// it costs the same whether or not anyone reads it and never fragments the
/// heap.
pub const CURRENT_BYTES: usize = 4_096;

/// Retained size for the previous boot. Smaller than the current buffer because
/// its job is narrower: the lines immediately before a restart.
pub const PREVIOUS_BYTES: usize = 2_048;

/// Stack buffer one rendered line is formatted into. Every task that logs pays
/// this in stack depth, so it stays just above the line budget rather than
/// generous.
const RENDER_BYTES: usize = MAX_LINE_BYTES + 16;

/// Survives a software reset: the linker places `.noinit` outside both the
/// startup zeroing and the heap. Contents from a previous boot are validated,
/// never trusted — see [`LogBuffer::is_intact`].
#[link_section = ".noinit"]
static mut CURRENT: LogBuffer<CURRENT_BYTES> = LogBuffer::new();

/// The previous boot's lines, copied out of `CURRENT` before this boot reuses it.
/// Ordinary zero-initialized memory: it reads as absent until a boot fills it.
static mut PREVIOUS: LogBuffer<PREVIOUS_BYTES> = LogBuffer::new();

struct Buffers {
    current: &'static mut LogBuffer<CURRENT_BYTES>,
    previous: &'static mut LogBuffer<PREVIOUS_BYTES>,
}

static BUFFERS: OnceLock<Mutex<Buffers>> = OnceLock::new();
static INSTALLED: Once = Once::new();

/// Start capturing. Call once, as early in the boot as possible: lines logged
/// before this land on the UART only.
pub fn install() {
    INSTALLED.call_once(|| {
        // Sound because `Once` runs this body exactly once, and nothing else
        // in the crate names these statics.
        let current = unsafe { &mut *addr_of_mut!(CURRENT) };
        let previous = unsafe { &mut *addr_of_mut!(PREVIOUS) };
        // Counting on from the retained buffer guarantees this boot's id differs
        // from the one a reader may still be holding lines for. A cold boot has
        // nothing to count from, so it starts somewhere unlikely to repeat what
        // an earlier power-on chose.
        let boot = if current.is_intact() {
            let carried = current.boot().wrapping_add(1);
            current.copy_into(previous);
            carried
        } else {
            unsafe { esp_random() }
        };
        current.reset(boot);
        let _ = BUFFERS.set(Mutex::new(Buffers { current, previous }));

        // Installed after the snapshot so the previous boot's lines are safe
        // before this boot can write over them.
        unsafe { esp_log_set_vprintf(Some(capture_line)) };
        if unsafe { heap_caps_register_failed_alloc_callback(Some(note_allocation_failure)) }
            != ESP_OK
        {
            log::warn!("allocation failures will not be captured in the device log");
        }
    });
}

/// Read both buffers under one lock. `None` before [`install`] has run.
///
/// The closure runs with logging blocked, so it must not log, and it must not
/// do anything slow: copy what is needed and get out. Serializing a response
/// inside it would hold every logging task behind a socket write.
pub fn with_buffers<T>(
    action: impl FnOnce(&LogBuffer<CURRENT_BYTES>, Option<&LogBuffer<PREVIOUS_BYTES>>) -> T,
) -> Option<T> {
    let buffers = BUFFERS.get()?;
    // A poisoned lock still guards readable bytes, and losing the device log
    // because an unrelated task panicked would defeat the point.
    let guard = buffers.lock().unwrap_or_else(|error| error.into_inner());
    let previous = guard.previous.is_intact().then_some(&*guard.previous);
    Some(action(&*guard.current, previous))
}

/// ESP-IDF's log sink: render the line, keep it, then put it on the UART.
///
/// Rendering consumes the argument list once and the rendered bytes are
/// written out afterwards, rather than forwarding the list to the original
/// sink, because a `va_list` cannot portably be read twice.
unsafe extern "C" fn capture_line(format: *const c_char, arguments: va_list) -> c_int {
    let mut line = [0_u8; RENDER_BYTES];
    let written = unsafe { vsnprintf(line.as_mut_ptr().cast(), line.len(), format, arguments) };
    if written <= 0 {
        return written;
    }
    // vsnprintf reports the length it wanted; the buffer holds at most one
    // less than its size, the rest being the terminator it always writes.
    let length = (written as usize).min(line.len() - 1);
    if let Some(buffers) = BUFFERS.get() {
        let mut guard = buffers.lock().unwrap_or_else(|error| error.into_inner());
        guard.current.append(&line[..length]);
    }
    // Outside the lock: a UART write is slow enough to stall every other task
    // that wants to log.
    unsafe { esp_rom_printf(c"%s".as_ptr(), line.as_ptr()) };
    written
}

/// ESP-IDF's allocation-failure hook, called before the abort that follows a
/// failed allocation. Formats on the stack and takes the lock only if it is
/// free: the heap is exhausted, and the task that holds the lock may be the
/// one whose allocation just failed.
unsafe extern "C" fn note_allocation_failure(size: usize, caps: u32, caller: *const c_char) {
    let caller = if caller.is_null() {
        "unknown"
    } else {
        unsafe { CStr::from_ptr(caller) }
            .to_str()
            .unwrap_or("unknown")
    };
    let free = unsafe { esp_get_free_heap_size() };
    let largest = unsafe { heap_caps_get_largest_free_block(caps) };
    let mut line = StackLine::new();
    let _ = write!(
        line,
        "E heap: {caller} could not allocate {size} bytes (caps 0x{caps:x}); \
         {free} bytes free, largest block {largest}"
    );
    if let Some(buffers) = BUFFERS.get() {
        if let Ok(mut guard) = buffers.try_lock() {
            guard.current.append(line.as_bytes());
        }
    }
    unsafe { esp_rom_printf(c"%s\n".as_ptr(), line.as_c_str().as_ptr()) };
}

extern "C" {
    fn vsnprintf(
        buffer: *mut c_char,
        size: usize,
        format: *const c_char,
        arguments: va_list,
    ) -> c_int;
}

/// A line formatted on the stack. Writing past the end is dropped rather than
/// grown: this exists for the path where the heap has already refused.
struct StackLine {
    bytes: [u8; RENDER_BYTES],
    length: usize,
}

impl StackLine {
    const fn new() -> Self {
        Self {
            bytes: [0; RENDER_BYTES],
            length: 0,
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.length]
    }

    /// The line as a C string. One byte is always reserved for the terminator.
    fn as_c_str(&self) -> &CStr {
        CStr::from_bytes_with_nul(&self.bytes[..self.length + 1]).unwrap_or(c"")
    }
}

impl Write for StackLine {
    fn write_str(&mut self, text: &str) -> core::fmt::Result {
        let room = self.bytes.len() - 1 - self.length;
        let taken = text.len().min(room);
        self.bytes[self.length..self.length + taken].copy_from_slice(&text.as_bytes()[..taken]);
        self.length += taken;
        Ok(())
    }
}
