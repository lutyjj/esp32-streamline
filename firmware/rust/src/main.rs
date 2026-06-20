use streamline_firmware::{mode::select_boot_mode, protocol::PacketHeader};

fn main() {
    // Required by esp-idf-sys to link runtime patches on an ESP-IDF target.
    esp_idf_svc::sys::link_patches();
    esp_idf_svc::log::EspLogger::initialize_default();

    let header = PacketHeader::new(0).encode();
    log::info!(
        "StreamLine Rust spike started: mode={:?} packet_header_bytes={}",
        select_boot_mode(false),
        header.len()
    );
}
