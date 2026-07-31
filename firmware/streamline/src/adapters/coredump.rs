//! Crash-dump storage access.
//!
//! The ESP-IDF panic handler writes an ELF core dump to the `coredump`
//! partition; this adapter reports, streams, and erases it. A flash layout
//! without the partition reports the capability unavailable, since OTA never
//! rewrites the partition table.

use esp_idf_svc::sys::{
    esp_core_dump_image_check, esp_core_dump_image_erase, esp_core_dump_image_get,
    esp_partition_find_first, esp_partition_read,
    esp_partition_subtype_t_ESP_PARTITION_SUBTYPE_DATA_COREDUMP, esp_partition_t,
    esp_partition_type_t_ESP_PARTITION_TYPE_DATA, ESP_OK,
};

/// What the coredump partition holds right now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CoredumpState {
    /// The running flash layout has no `coredump` partition.
    Unavailable,
    /// The partition exists and no valid dump is stored.
    Empty,
    /// A checksum-valid dump of `size_bytes` is stored.
    Present { size_bytes: u32 },
}

fn partition() -> Option<&'static esp_partition_t> {
    let found = unsafe {
        esp_partition_find_first(
            esp_partition_type_t_ESP_PARTITION_TYPE_DATA,
            esp_partition_subtype_t_ESP_PARTITION_SUBTYPE_DATA_COREDUMP,
            core::ptr::null(),
        )
    };
    // Partition entries are parsed once into static memory.
    unsafe { found.as_ref() }
}

fn stored_image() -> Option<(usize, usize)> {
    // `image_check` verifies the stored checksum; `image_get` reads only the
    // header. Both gate a reported dump, so a dump this module reports is one
    // `espcoredump.py` will accept.
    if unsafe { esp_core_dump_image_check() } != ESP_OK {
        return None;
    }
    let mut address = 0_usize;
    let mut size = 0_usize;
    (unsafe { esp_core_dump_image_get(&mut address, &mut size) } == ESP_OK)
        .then_some((address, size))
}

pub fn state() -> CoredumpState {
    if partition().is_none() {
        return CoredumpState::Unavailable;
    }
    match stored_image().map(|(_, size)| u32::try_from(size)) {
        Some(Ok(size_bytes)) => CoredumpState::Present { size_bytes },
        _ => CoredumpState::Empty,
    }
}

/// Stream the stored dump through `write` in bounded chunks, so the response
/// never materializes a partition's worth of bytes in one heap block.
pub fn read_image(mut write: impl FnMut(&[u8]) -> anyhow::Result<()>) -> anyhow::Result<()> {
    let partition = partition().ok_or_else(|| anyhow::anyhow!("no coredump partition"))?;
    let (address, size) = stored_image().ok_or_else(|| anyhow::anyhow!("no stored core dump"))?;
    // `image_get` reports an absolute flash address; `esp_partition_read`
    // takes a partition-relative offset.
    let mut offset = address
        .checked_sub(partition.address as usize)
        .ok_or_else(|| anyhow::anyhow!("core dump address precedes its partition"))?;
    let end = offset
        .checked_add(size)
        .filter(|end| *end <= partition.size as usize)
        .ok_or_else(|| anyhow::anyhow!("core dump exceeds its partition"))?;
    let mut buffer = [0_u8; 1_024];
    while offset < end {
        let chunk = usize::min(buffer.len(), end - offset);
        let read =
            unsafe { esp_partition_read(partition, offset, buffer.as_mut_ptr().cast(), chunk) };
        if read != ESP_OK {
            anyhow::bail!("core dump read failed at offset {offset}: {read}");
        }
        write(&buffer[..chunk])?;
        offset += chunk;
    }
    Ok(())
}

/// Erase the stored dump; erasing an empty partition succeeds.
pub fn erase() -> anyhow::Result<()> {
    let erased = unsafe { esp_core_dump_image_erase() };
    if erased != ESP_OK {
        anyhow::bail!("core dump erase failed: {erased}");
    }
    Ok(())
}
