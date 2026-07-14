//! Device resource sampling: RAM, NVS storage, uptime, and task count.
//!
//! Every value is read on demand from bookkeeping the kernel and heap allocator
//! already maintain, so a `/api/status` or `/api/metrics` request pays the whole
//! cost and an idle device pays nothing.

use esp_idf_svc::sys::{
    esp_timer_get_time, heap_caps_get_free_size, heap_caps_get_largest_free_block,
    heap_caps_get_minimum_free_size, heap_caps_get_total_size, nvs_get_stats, nvs_stats_t,
    uxTaskGetNumberOfTasks, ESP_OK, MALLOC_CAP_INTERNAL,
};

use crate::telemetry::{HeapTelemetry, NvsTelemetry, SystemTelemetry};

/// Sample current resource headroom. Safe from any task: the underlying reads
/// are non-blocking and internally synchronized.
pub fn snapshot() -> SystemTelemetry {
    SystemTelemetry {
        uptime_seconds: uptime_seconds(),
        // Returns UBaseType_t (u32); the tasks are the kernel's own count.
        task_count: unsafe { uxTaskGetNumberOfTasks() },
        heap: heap(),
        nvs: nvs(),
    }
}

fn uptime_seconds() -> u64 {
    // esp_timer is monotonic microseconds since boot, so it is never negative
    // in practice; clamp defensively before the unsigned conversion.
    let micros = unsafe { esp_timer_get_time() };
    u64::try_from(micros).unwrap_or(0) / 1_000_000
}

/// Internal RAM heap. One capability mask keeps free, total, low-water, and
/// largest-block reported against the same set of regions.
fn heap() -> HeapTelemetry {
    let caps = MALLOC_CAP_INTERNAL;
    HeapTelemetry {
        free_bytes: unsafe { heap_caps_get_free_size(caps) } as u32,
        total_bytes: unsafe { heap_caps_get_total_size(caps) } as u32,
        minimum_free_bytes: unsafe { heap_caps_get_minimum_free_size(caps) } as u32,
        largest_free_block_bytes: unsafe { heap_caps_get_largest_free_block(caps) } as u32,
    }
}

/// The default NVS partition, where this firmware stores its configuration. A
/// read failure reports all-zero usage (including `total_entries`) rather than
/// blocking the status response, so a consumer computing a used/total ratio
/// must guard against a zero total.
fn nvs() -> NvsTelemetry {
    let mut stats = nvs_stats_t::default();
    // A null partition name selects the default `nvs` partition.
    let result = unsafe { nvs_get_stats(core::ptr::null(), &mut stats) };
    if result != ESP_OK {
        log::warn!("could not read NVS statistics: esp_err {result}");
        return NvsTelemetry::default();
    }
    NvsTelemetry {
        used_entries: stats.used_entries as u32,
        available_entries: stats.available_entries as u32,
        total_entries: stats.total_entries as u32,
    }
}
