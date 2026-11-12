fn main() {
    let path = std::env::args().nth(1).expect("output path is required");
    std::fs::write(path, streamline_firmware::api::openapi_json()).expect("write OpenAPI document");
    if let Some(path) = std::env::args().nth(2) {
        use utoipa::OpenApi;
        #[derive(OpenApi)]
        #[openapi(
            info(title = "StreamLine telemetry API", version = "1.0.0"),
            components(schemas(
                streamline_firmware::telemetry::SessionRequest,
                streamline_firmware::telemetry::TelemetryStatus,
                streamline_firmware::telemetry::SessionState
            ))
        )]
        struct TelemetryApi;
        std::fs::write(path, TelemetryApi::openapi().to_pretty_json().unwrap())
            .expect("write telemetry contract");
    }
}
