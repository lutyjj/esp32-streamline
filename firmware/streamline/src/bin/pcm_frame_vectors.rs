//! Refreshes the cross-language PCM frame conformance corpus.
//!
//! `make firmware-pcm-frame-vectors` runs this after a protocol change to rewrite
//! `docs/pcm-frame-vectors.json`. `firmware-test` and `bridge-test` then prove
//! the encoder and the bridge parser still agree with it.

fn main() {
    let path = std::env::args().nth(1).expect("output path is required");
    let mut json = serde_json::to_string_pretty(&streamline_firmware::conformance::vectors())
        .expect("serialize conformance vectors");
    json.push('\n');
    std::fs::write(path, json).expect("write conformance vectors");
}
