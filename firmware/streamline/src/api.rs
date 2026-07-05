//! Device HTTP API contract.
//!
//! Firmware handlers use the endpoint constants and DTOs in this module. The
//! OpenAPI document and console TypeScript types are generated from the same
//! Rust definitions.

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::{
    config::{InputLine, RuntimeConfig},
    telemetry::TelemetrySnapshot,
};

pub const API_TITLE: &str = "StreamLine Device API";
pub const API_DESCRIPTION: &str =
    "HTTP API exposed by one ESP32 StreamLine device on a trusted LAN.";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
}

impl HttpMethod {
    #[cfg(feature = "openapi")]
    const fn openapi_name(self) -> &'static str {
        match self {
            Self::Get => "get",
            Self::Post => "post",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Endpoint {
    pub method: HttpMethod,
    pub path: &'static str,
    pub tag: &'static str,
    pub operation_id: &'static str,
    pub summary: &'static str,
    pub secured: bool,
    pub request: Option<RequestBody>,
    pub responses: &'static [Response],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RequestBody {
    pub required: bool,
    pub content_type: &'static str,
    pub schema: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Response {
    pub status: u16,
    pub description: &'static str,
    pub content: Option<ResponseContent>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseContent {
    Json(&'static str),
    Text,
}

const JSON_FORM: &str = "application/x-www-form-urlencoded";

const OPENAPI_RESPONSES: &[Response] = &[Response {
    status: 200,
    description: "The device API contract as JSON.",
    content: Some(ResponseContent::Json("OpenApiDocument")),
}];
const STATUS_RESPONSES: &[Response] = &[Response {
    status: 200,
    description: "Runtime, network, audio, diagnostics, and OTA state.",
    content: Some(ResponseContent::Json("DeviceStatus")),
}];
const METRICS_RESPONSES: &[Response] = &[Response {
    status: 200,
    description: "Prometheus exposition text.",
    content: Some(ResponseContent::Text),
}];
const SETTINGS_RESPONSES: &[Response] = &[Response {
    status: 200,
    description: "Persisted settings safe to show in the console.",
    content: Some(ResponseContent::Json("DeviceConfig")),
}];
const MUTATION_RESPONSES: &[Response] = &[
    Response {
        status: 200,
        description: "Mutation accepted.",
        content: Some(ResponseContent::Json("Ack")),
    },
    Response {
        status: 400,
        description: "The request body is invalid.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
    Response {
        status: 401,
        description: "The admin key is absent or invalid.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
];
const UNLOCK_RESPONSES: &[Response] = &[
    Response {
        status: 200,
        description: "The supplied key is accepted.",
        content: Some(ResponseContent::Json("Ack")),
    },
    Response {
        status: 401,
        description: "The admin key is absent or invalid.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
];
const OTA_RESPONSES: &[Response] = &[
    Response {
        status: 202,
        description: "Background OTA work started; poll status.ota for progress.",
        content: Some(ResponseContent::Json("Ack")),
    },
    Response {
        status: 400,
        description: "The request body is invalid.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
    Response {
        status: 401,
        description: "The admin key is absent or invalid.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
    Response {
        status: 409,
        description: "An OTA check or install is already running.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
];
const OTA_CHECK_RESPONSES: &[Response] = &[
    Response {
        status: 202,
        description: "Background OTA check started; poll status.ota for the result.",
        content: Some(ResponseContent::Json("Ack")),
    },
    Response {
        status: 401,
        description: "The admin key is absent or invalid.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
    Response {
        status: 409,
        description: "An OTA check or install is already running.",
        content: Some(ResponseContent::Json("ErrorResponse")),
    },
];

pub const OPENAPI_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Get,
    path: "/api/openapi.json",
    tag: "Runtime",
    operation_id: "getOpenApi",
    summary: "Get the OpenAPI contract.",
    secured: false,
    request: None,
    responses: OPENAPI_RESPONSES,
};
pub const STATUS_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Get,
    path: "/api/status",
    tag: "Runtime",
    operation_id: "getStatus",
    summary: "Get runtime status.",
    secured: false,
    request: None,
    responses: STATUS_RESPONSES,
};
pub const METRICS_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Get,
    path: "/api/metrics",
    tag: "Runtime",
    operation_id: "getMetrics",
    summary: "Get Prometheus metrics.",
    secured: false,
    request: None,
    responses: METRICS_RESPONSES,
};
pub const SETTINGS_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Get,
    path: "/api/settings",
    tag: "Settings",
    operation_id: "getSettings",
    summary: "Get persisted settings without secrets.",
    secured: false,
    request: None,
    responses: SETTINGS_RESPONSES,
};
pub const NETWORK_SETTINGS_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/settings/network",
    tag: "Settings",
    operation_id: "setNetworkSettings",
    summary: "Save Wi-Fi and stream target settings.",
    secured: true,
    request: Some(RequestBody {
        required: true,
        content_type: JSON_FORM,
        schema: "NetworkSettingsForm",
    }),
    responses: MUTATION_RESPONSES,
};
pub const AUDIO_SETTINGS_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/settings/audio",
    tag: "Settings",
    operation_id: "setAudioSettings",
    summary: "Save input gain, line, and attenuation.",
    secured: true,
    request: Some(RequestBody {
        required: true,
        content_type: JSON_FORM,
        schema: "AudioSettingsForm",
    }),
    responses: MUTATION_RESPONSES,
};
pub const DEVICE_NAME_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/settings/name",
    tag: "Settings",
    operation_id: "setDeviceName",
    summary: "Save the friendly device name.",
    secured: true,
    request: Some(RequestBody {
        required: false,
        content_type: JSON_FORM,
        schema: "DeviceNameForm",
    }),
    responses: MUTATION_RESPONSES,
};
pub const ADMIN_KEY_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/settings/admin-key",
    tag: "Settings",
    operation_id: "setAdminKey",
    summary: "Replace the admin key.",
    secured: true,
    request: Some(RequestBody {
        required: true,
        content_type: JSON_FORM,
        schema: "AdminKeyForm",
    }),
    responses: MUTATION_RESPONSES,
};
pub const UNLOCK_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/unlock",
    tag: "Actions",
    operation_id: "unlock",
    summary: "Check whether an admin key is accepted.",
    secured: true,
    request: None,
    responses: UNLOCK_RESPONSES,
};
pub const RESTART_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/restart",
    tag: "Actions",
    operation_id: "restart",
    summary: "Restart the device.",
    secured: true,
    request: None,
    responses: UNLOCK_RESPONSES,
};
pub const FACTORY_RESET_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/factory-reset",
    tag: "Actions",
    operation_id: "factoryReset",
    summary: "Erase persisted settings and restart.",
    secured: true,
    request: None,
    responses: UNLOCK_RESPONSES,
};
pub const OTA_CHECK_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/ota/check",
    tag: "Actions",
    operation_id: "checkOta",
    summary: "Check for a newer firmware release.",
    secured: true,
    request: None,
    responses: OTA_CHECK_RESPONSES,
};
pub const OTA_UPDATE_ENDPOINT: Endpoint = Endpoint {
    method: HttpMethod::Post,
    path: "/api/ota/update",
    tag: "Actions",
    operation_id: "updateOta",
    summary: "Install firmware from the latest release or a pinned custom image.",
    secured: true,
    request: Some(RequestBody {
        required: false,
        content_type: JSON_FORM,
        schema: "OtaUpdateForm",
    }),
    responses: OTA_RESPONSES,
};

pub const ENDPOINTS: &[Endpoint] = &[
    OPENAPI_ENDPOINT,
    STATUS_ENDPOINT,
    METRICS_ENDPOINT,
    SETTINGS_ENDPOINT,
    NETWORK_SETTINGS_ENDPOINT,
    AUDIO_SETTINGS_ENDPOINT,
    DEVICE_NAME_ENDPOINT,
    ADMIN_KEY_ENDPOINT,
    UNLOCK_ENDPOINT,
    RESTART_ENDPOINT,
    FACTORY_RESET_ENDPOINT,
    OTA_CHECK_ENDPOINT,
    OTA_UPDATE_ENDPOINT,
];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct Ack {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rebooting: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started: Option<bool>,
}

impl Ack {
    pub const fn ok() -> Self {
        Self {
            ok: Some(true),
            rebooting: None,
            started: None,
        }
    }

    pub const fn rebooting() -> Self {
        Self {
            ok: Some(true),
            rebooting: Some(true),
            started: None,
        }
    }

    pub const fn started() -> Self {
        Self {
            ok: Some(true),
            rebooting: None,
            started: Some(true),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct ErrorResponse {
    pub error: String,
}

impl ErrorResponse {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct DeviceConfig {
    pub device_name: String,
    pub ssid: String,
    pub target_host: String,
    pub target_port: u16,
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_atten_db: u8,
    pub config_source: String,
}

impl DeviceConfig {
    pub fn from_runtime(config: &RuntimeConfig) -> Self {
        Self {
            device_name: config.device_name.clone(),
            ssid: config.ssid.clone(),
            target_host: config.target_host.clone(),
            target_port: config.target_port,
            input_line: input_line_number(config.audio.input_line),
            input_gain: config.audio.input_gain,
            adc_atten_db: config.audio.adc_attenuation_db,
            config_source: "nvs".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct DeviceStatus {
    pub firmware_version: String,
    pub device_name: String,
    pub mode: String,
    pub config_source: String,
    pub web_server: bool,
    pub configuration_writable: bool,
    pub auth_required: bool,
    pub wifi: WifiStatus,
    pub target: TargetStatus,
    pub audio: AudioStatus,
    pub metrics: MetricsStatus,
    pub diagnostics: DiagnosticsStatus,
    pub ota: OtaSnapshot,
}

impl DeviceStatus {
    pub fn from_snapshot(snapshot: &TelemetrySnapshot) -> Self {
        Self {
            firmware_version: snapshot.firmware_version.to_owned(),
            device_name: snapshot.device_name.clone(),
            mode: snapshot.mode.to_owned(),
            config_source: snapshot.config_source.to_owned(),
            web_server: snapshot.web_server,
            configuration_writable: snapshot.configuration_writable,
            auth_required: snapshot.auth_required,
            wifi: WifiStatus {
                hostname: snapshot.wifi.hostname.clone(),
                ssid: snapshot.wifi.ssid.clone(),
                status: snapshot.wifi.status.to_owned(),
                sta_ip: snapshot.wifi.sta_ip.clone(),
                ap_ip: snapshot.wifi.ap_ip.clone(),
                rssi: snapshot.wifi.rssi_dbm,
            },
            target: TargetStatus {
                target_host: snapshot.target.host.clone(),
                target_port: snapshot.target.port,
                transport: snapshot.target.transport.to_owned(),
            },
            audio: AudioStatus {
                input_line: snapshot.audio.input_line,
                input_gain: snapshot.audio.input_gain,
                adc_atten_db: snapshot.audio.adc_attenuation_db,
                sample_rate: snapshot.audio.sample_rate_hz,
                channels: snapshot.audio.channels,
                bits_per_sample: snapshot.audio.bits_per_sample,
            },
            metrics: MetricsStatus {
                sequence: snapshot.stream.sequence,
                packets: snapshot.stream.packets_total,
                bytes: snapshot.stream.bytes_total,
                read_errors: snapshot.stream.read_errors_total,
                short_reads: snapshot.stream.short_reads_total,
                queue_depth: snapshot.stream.queue_depth,
                queue_drops_total: snapshot.stream.queue_drops_total,
                network_errors_total: snapshot.stream.network_errors_total,
                reconnects_total: snapshot.stream.reconnects_total,
                clip_threshold_abs: snapshot.audio.clip_threshold_abs,
                peak_abs_left: snapshot.audio.peak_abs_left,
                peak_abs_right: snapshot.audio.peak_abs_right,
                rms_left: snapshot.audio.rms_left,
                rms_right: snapshot.audio.rms_right,
                noise_floor: snapshot.audio.noise_floor,
                clipped_samples_total: snapshot.audio.clipped_samples_total,
                playing: snapshot.audio.playing,
            },
            diagnostics: DiagnosticsStatus {
                reset_reason: snapshot.diagnostics.reset_reason.to_owned(),
                last_fallback: snapshot.diagnostics.last_fallback.clone(),
                last_ota: snapshot.diagnostics.last_ota.clone(),
            },
            ota: OtaSnapshot {
                phase: snapshot.ota.phase.to_owned(),
                bytes_written: snapshot.ota.bytes_written,
                bytes_total: snapshot.ota.bytes_total,
                latest_version: snapshot.ota.latest_version.clone(),
                message: snapshot.ota.message.clone(),
                busy: snapshot.ota.busy,
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct WifiStatus {
    pub hostname: String,
    pub ssid: String,
    pub status: String,
    pub sta_ip: String,
    pub ap_ip: String,
    pub rssi: i32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct TargetStatus {
    pub target_host: String,
    pub target_port: u16,
    pub transport: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct AudioStatus {
    pub input_line: u8,
    pub input_gain: u8,
    pub adc_atten_db: u8,
    pub sample_rate: u32,
    pub channels: u8,
    pub bits_per_sample: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct MetricsStatus {
    pub sequence: u32,
    pub packets: u64,
    pub bytes: u64,
    pub read_errors: u64,
    pub short_reads: u64,
    pub queue_depth: u32,
    pub queue_drops_total: u64,
    pub network_errors_total: u64,
    pub reconnects_total: u64,
    pub clip_threshold_abs: u16,
    pub peak_abs_left: u32,
    pub peak_abs_right: u32,
    pub rms_left: u32,
    pub rms_right: u32,
    pub noise_floor: u32,
    pub clipped_samples_total: u64,
    pub playing: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct DiagnosticsStatus {
    pub reset_reason: String,
    pub last_fallback: String,
    pub last_ota: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct OtaSnapshot {
    pub phase: String,
    pub bytes_written: u32,
    pub bytes_total: u32,
    pub latest_version: String,
    pub message: String,
    pub busy: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct NetworkSettingsForm {
    pub ssid: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub target_host: String,
    pub target_port: u16,
    #[serde(default)]
    pub admin_secret: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioSettingsForm {
    pub line: u8,
    pub gain: u8,
    pub atten: u8,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct DeviceNameForm {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AdminKeyForm {
    pub admin_secret: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct OtaUpdateForm {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

pub fn parse_form<T: DeserializeOwned>(body: &[u8]) -> Result<T, String> {
    serde_urlencoded::from_bytes(body).map_err(|error| error.to_string())
}

const fn input_line_number(line: InputLine) -> u8 {
    match line {
        InputLine::One => 1,
        InputLine::Two => 2,
    }
}

#[cfg(feature = "openapi")]
pub fn openapi_json() -> String {
    let document = openapi::document();
    format!(
        "{}\n",
        serde_json::to_string_pretty(&document).expect("OpenAPI document is serializable")
    )
}

#[cfg(feature = "openapi")]
mod openapi {
    use serde_json::{json, Map, Value};
    use utoipa::OpenApi;

    use super::{
        Ack, AdminKeyForm, AudioSettingsForm, AudioStatus, DeviceConfig, DeviceNameForm,
        DeviceStatus, DiagnosticsStatus, Endpoint, ErrorResponse, MetricsStatus,
        NetworkSettingsForm, OtaSnapshot, OtaUpdateForm, Response, ResponseContent, TargetStatus,
        WifiStatus, API_DESCRIPTION, API_TITLE, ENDPOINTS,
    };

    #[derive(OpenApi)]
    #[openapi(components(schemas(
        Ack,
        ErrorResponse,
        DeviceConfig,
        DeviceStatus,
        WifiStatus,
        TargetStatus,
        AudioStatus,
        MetricsStatus,
        DiagnosticsStatus,
        OtaSnapshot,
        NetworkSettingsForm,
        AudioSettingsForm,
        DeviceNameForm,
        AdminKeyForm,
        OtaUpdateForm
    )))]
    struct SchemaDoc;

    pub fn document() -> Value {
        let mut document =
            serde_json::to_value(SchemaDoc::openapi()).expect("OpenAPI document is serializable");
        let root = document
            .as_object_mut()
            .expect("OpenAPI document root is an object");

        root.insert("openapi".to_owned(), json!("3.1.0"));
        root.insert(
            "info".to_owned(),
            json!({
                "title": API_TITLE,
                "version": env!("CARGO_PKG_VERSION"),
                "description": API_DESCRIPTION,
            }),
        );
        root.insert("servers".to_owned(), json!([{ "url": "/" }]));
        root.insert(
            "tags".to_owned(),
            json!([
                { "name": "Runtime" },
                { "name": "Settings" },
                { "name": "Actions" },
            ]),
        );
        root.insert("paths".to_owned(), Value::Object(paths()));

        let components = root
            .entry("components")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("OpenAPI components is an object");
        components.insert(
            "securitySchemes".to_owned(),
            json!({
                "adminKey": {
                    "type": "http",
                    "scheme": "bearer",
                    "description": "Per-device admin key. Required for mutating endpoints once provisioned."
                }
            }),
        );
        components
            .entry("schemas")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .expect("OpenAPI schemas is an object")
            .insert("OpenApiDocument".to_owned(), openapi_document_schema());

        document
    }

    fn paths() -> Map<String, Value> {
        let mut paths = Map::new();
        for endpoint in ENDPOINTS {
            let path = paths
                .entry(endpoint.path.to_owned())
                .or_insert_with(|| Value::Object(Map::new()));
            path.as_object_mut()
                .expect("OpenAPI path item is an object")
                .insert(
                    endpoint.method.openapi_name().to_owned(),
                    operation(endpoint),
                );
        }
        paths
    }

    fn operation(endpoint: &Endpoint) -> Value {
        let mut operation = Map::new();
        operation.insert("tags".to_owned(), json!([endpoint.tag]));
        operation.insert("operationId".to_owned(), json!(endpoint.operation_id));
        operation.insert("summary".to_owned(), json!(endpoint.summary));
        if endpoint.secured {
            operation.insert("security".to_owned(), json!([{ "adminKey": [] }]));
        }
        if let Some(request) = endpoint.request {
            operation.insert(
                "requestBody".to_owned(),
                json!({
                    "required": request.required,
                    "content": {
                        request.content_type: {
                            "schema": schema_ref(request.schema)
                        }
                    }
                }),
            );
        }
        operation.insert(
            "responses".to_owned(),
            Value::Object(responses(endpoint.responses)),
        );
        Value::Object(operation)
    }

    fn responses(items: &[Response]) -> Map<String, Value> {
        let mut responses = Map::new();
        for response in items {
            let mut body = Map::new();
            body.insert("description".to_owned(), json!(response.description));
            if let Some(content) = response.content {
                body.insert("content".to_owned(), response_content(content));
            }
            responses.insert(response.status.to_string(), Value::Object(body));
        }
        responses
    }

    fn response_content(content: ResponseContent) -> Value {
        match content {
            ResponseContent::Json(schema) => json!({
                "application/json": {
                    "schema": schema_ref(schema)
                }
            }),
            ResponseContent::Text => json!({
                "text/plain": {
                    "schema": { "type": "string" }
                }
            }),
        }
    }

    fn schema_ref(schema: &str) -> Value {
        json!({ "$ref": format!("#/components/schemas/{schema}") })
    }

    fn openapi_document_schema() -> Value {
        json!({
            "type": "object",
            "additionalProperties": true,
            "required": ["openapi", "info", "paths"],
            "properties": {
                "openapi": { "type": "string" },
                "info": {
                    "type": "object",
                    "additionalProperties": true,
                    "required": ["title", "version"],
                    "properties": {
                        "title": { "type": "string" },
                        "version": { "type": "string" },
                        "description": { "type": "string" }
                    }
                },
                "paths": {
                    "type": "object",
                    "additionalProperties": {
                        "type": "object",
                        "additionalProperties": true
                    }
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_form, NetworkSettingsForm, OtaUpdateForm};

    #[test]
    fn decodes_browser_urlencoded_forms_into_request_types() {
        let form: NetworkSettingsForm =
            parse_form(b"ssid=Studio+WiFi&target_host=bridge%2Elocal&target_port=39000")
                .expect("valid form");

        assert_eq!(form.ssid, "Studio WiFi");
        assert_eq!(form.target_host, "bridge.local");
        assert_eq!(form.target_port, 39_000);
        assert!(form.password.is_empty());
        assert!(form.admin_secret.is_empty());
    }

    #[test]
    fn rejects_fields_not_owned_by_the_request_type() {
        let error = parse_form::<NetworkSettingsForm>(
            b"ssid=Studio&target_host=bridge.local&target_port=39000&surprise=true",
        )
        .expect_err("unexpected field");

        assert!(error.contains("unknown field"));
    }

    #[test]
    fn accepts_empty_ota_update_forms() {
        let form: OtaUpdateForm = parse_form(b"").expect("empty form");

        assert_eq!(form, OtaUpdateForm::default());
    }
}
