use std::io::Write;
use std::path::Path;

fn main() {
    embuild::espidf::sysenv::output();
    // esp-idf-sys propagates sdkconfig options as `esp_idf_*` cfgs but does not
    // register them for the unexpected-cfg lint. Declare the one the firmware
    // reads (OTA signature enforcement) so the strict build stays warning-clean.
    println!("cargo::rustc-check-cfg=cfg(esp_idf_secure_signed_on_update_no_secure_boot)");
    compress_embedded_assets();
}

/// Gzip the assets the HTTP adapter embeds, so the image stores and serves
/// them compressed: raw, the console and OpenAPI document cost 194 KB of an
/// OTA slot that compression cuts to 50 KB. The adapter `include_bytes!`s the
/// results from `OUT_DIR` and serves them with `Content-Encoding: gzip`.
fn compress_embedded_assets() {
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    for (source, compressed) in [
        ("../../console/dist/index.html", "index.html.gz"),
        ("../../docs/openapi.json", "openapi.json.gz"),
    ] {
        println!("cargo::rerun-if-changed={source}");
        let Ok(bytes) = std::fs::read(source) else {
            // Host builds compile only the crate core, which embeds nothing,
            // and the console asset is generated, so it may be absent. The
            // device build embeds the files and must fail here with the fix,
            // not later with an opaque missing-OUT_DIR-file error.
            if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("espidf") {
                panic!("{source} is missing; build it with: make -C firmware console-asset");
            }
            continue;
        };
        let target = Path::new(&out_dir).join(compressed);
        let file = std::fs::File::create(&target)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", target.display()));
        let mut encoder = flate2::write::GzEncoder::new(file, flate2::Compression::best());
        encoder
            .write_all(&bytes)
            .and_then(|()| encoder.finish().map(drop))
            .unwrap_or_else(|error| panic!("cannot gzip {source}: {error}"));
    }
}
