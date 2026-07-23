fn main() {
    embuild::espidf::sysenv::output();
    // esp-idf-sys propagates sdkconfig options as `esp_idf_*` cfgs but does not
    // register them for the unexpected-cfg lint. Declare the one the firmware
    // reads (OTA signature enforcement) so the strict build stays warning-clean.
    println!("cargo::rustc-check-cfg=cfg(esp_idf_secure_signed_on_update_no_secure_boot)");
}
