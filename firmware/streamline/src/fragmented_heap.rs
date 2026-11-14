//! Host tests of allocation failure: a test thread can limit its own
//! allocations to the largest free block a fragmented device heap reports.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
};

thread_local! {
    static LARGEST_BLOCK: Cell<usize> = const { Cell::new(usize::MAX) };
}

struct FragmentedHeap;

// SAFETY: every call forwards to `System` unchanged or fails with null, as
// `GlobalAlloc::alloc` permits.
unsafe impl GlobalAlloc for FragmentedHeap {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.size() > LARGEST_BLOCK.try_with(Cell::get).unwrap_or(usize::MAX) {
            return std::ptr::null_mut();
        }
        // SAFETY: the caller upholds `alloc`'s contract for `layout`.
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from `System.alloc` with this `layout`.
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: FragmentedHeap = FragmentedHeap;

/// Run `action` with this thread's allocations above `bytes` failing.
pub fn with_largest_block<R>(bytes: usize, action: impl FnOnce() -> R) -> R {
    let previous = LARGEST_BLOCK.replace(bytes);
    let result = action();
    LARGEST_BLOCK.set(previous);
    result
}
