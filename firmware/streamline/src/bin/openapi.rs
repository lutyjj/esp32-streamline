fn main() {
    let path = std::env::args().nth(1).expect("output path is required");
    std::fs::write(path, streamline_firmware::api::openapi_json()).expect("write OpenAPI document");
}
