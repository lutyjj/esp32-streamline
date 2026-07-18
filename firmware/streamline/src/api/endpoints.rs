//! HTTP route table and OpenAPI generation.
//!
//! The `endpoint!` macro declares each route's metadata and, under the
//! `api-spec` feature, the utoipa operation that generates its OpenAPI path.
//! Request and response DTOs live in the sibling `requests`/`responses`
//! modules and are imported here for that generation pass.

#[cfg(feature = "api-spec")]
use super::{requests::*, responses::*};
#[cfg(feature = "api-spec")]
use crate::health::HealthReport;
#[cfg(feature = "api-spec")]
use crate::profiles::AudioProfileCatalog;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HttpMethod {
    Get,
    Post,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Endpoint {
    pub method: HttpMethod,
    pub path: &'static str,
    pub auth: bool,
    pub contract: ResponseContract,
}

/// How an endpoint declares its response set in the generated spec.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseContract {
    /// Endpoint-specific responses, written out in the declaration.
    Custom,
    /// A device-configuration mutation: one success status plus the complete
    /// [`crate::mutation::MutationError`] taxonomy and the auth failure. The
    /// `mutation` macro arm declares the set once; a test pins the generated
    /// artifact to the runtime taxonomy.
    Mutation { success: u16 },
}

macro_rules! endpoint {
    ($name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, public, $($contract:tt)*) => {
        pub const $name: Endpoint = Endpoint {
            method: HttpMethod::$method,
            path: $path,
            auth: false,
            contract: ResponseContract::Custom,
        };
        #[cfg(feature = "api-spec")]
        #[allow(dead_code)]
        #[utoipa::path($verb, path = $path, $($contract)*)]
        fn $operation() {}
    };
    ($name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, authenticated, $($contract:tt)*) => {
        pub const $name: Endpoint = Endpoint {
            method: HttpMethod::$method,
            path: $path,
            auth: true,
            contract: ResponseContract::Custom,
        };
        #[cfg(feature = "api-spec")]
        #[allow(dead_code)]
        #[utoipa::path(
            $verb,
            path = $path,
            security(("bearer_auth" = [])),
            $($contract)*
        )]
        fn $operation() {}
    };
    ($name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, mutation($success:literal, $body:ty) $(,)?) => {
        endpoint!(@mutation $name, $operation, $method, $verb, $path, ($success, $body),);
    };
    ($name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, mutation($success:literal, $body:ty), $($contract:tt)+) => {
        endpoint!(@mutation $name, $operation, $method, $verb, $path, ($success, $body), $($contract)+,);
    };
    (@mutation $name:ident, $operation:ident, $method:ident, $verb:ident, $path:literal, ($success:literal, $body:ty), $($contract:tt)*) => {
        pub const $name: Endpoint = Endpoint {
            method: HttpMethod::$method,
            path: $path,
            auth: true,
            contract: ResponseContract::Mutation { success: $success },
        };
        #[cfg(feature = "api-spec")]
        #[allow(dead_code)]
        #[utoipa::path(
            $verb,
            path = $path,
            security(("bearer_auth" = [])),
            $($contract)*
            responses(
                (status = $success, body = $body),
                (status = 400, body = ErrorResponse),
                (status = 401, body = ErrorResponse),
                (status = 409, body = ErrorResponse),
                (status = 503, body = ErrorResponse),
                (status = 500, body = ErrorResponse)
            )
        )]
        fn $operation() {}
    };
}

endpoint!(
    STATUS,
    get_status,
    Get,
    get,
    "/api/status",
    public,
    summary = "Read device status",
    responses((status = 200, body = StatusResponse))
);
endpoint!(
    HEALTH,
    get_health,
    Get,
    get,
    "/api/health",
    public,
    summary = "Read startup health",
    responses(
        (status = 200, body = HealthReport),
        (status = 503, body = HealthReport)
    )
);
endpoint!(
    METRICS,
    get_metrics,
    Get,
    get,
    "/api/metrics",
    public,
    summary = "Read Prometheus metrics",
    responses((status = 200, content_type = "text/plain", body = String))
);
endpoint!(
    SETTINGS,
    get_settings,
    Get,
    get,
    "/api/settings",
    public,
    summary = "Read device settings",
    responses((status = 200, body = ConfigResponse))
);
endpoint!(
    AUDIO_PROFILES,
    get_audio_profiles,
    Get,
    get,
    "/api/audio-profiles",
    public,
    summary = "Read saved audio profiles",
    responses((status = 200, body = AudioProfileCatalog))
);
endpoint!(
    BOARDS,
    get_boards,
    Get,
    get,
    "/api/boards",
    public,
    summary = "List board capabilities",
    responses((status = 200, body = BoardCatalogResponse))
);
endpoint!(
    OPENAPI,
    get_openapi,
    Get,
    get,
    "/api/openapi.json",
    public,
    summary = "Read the OpenAPI contract",
    responses((status = 200, body = Object))
);
endpoint!(
    SET_WIFI,
    set_wifi,
    Post,
    post,
    "/api/settings/wifi",
    mutation(200, Ack),
    summary = "Set Wi-Fi settings",
    request_body(
        content = WifiSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_TARGET,
    set_target,
    Post,
    post,
    "/api/settings/target",
    mutation(200, Ack),
    summary = "Set stream target",
    request_body(
        content = TargetSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_TRANSPORT,
    set_transport_mode,
    Post,
    post,
    "/api/settings/transport",
    mutation(200, Ack),
    summary = "Set the PCM transport mode",
    request_body(
        content = TransportSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    TRANSPORT_KEY_STAGE,
    stage_transport_key,
    Post,
    post,
    "/api/transport/keys/stage",
    mutation(200, TransportKeyResponse),
    summary = "Generate and stage a per-device PCM transport key"
);
endpoint!(
    TRANSPORT_KEY_VERIFY,
    verify_transport_key,
    Post,
    post,
    "/api/transport/keys/verify",
    mutation(200, Ack),
    summary = "Verify the pending PCM transport key against the bridge"
);
endpoint!(
    TRANSPORT_KEY_ACTIVATE,
    activate_transport_key,
    Post,
    post,
    "/api/transport/keys/activate",
    mutation(200, Ack),
    summary = "Activate the verified PCM transport key"
);
endpoint!(
    TRANSPORT_KEY_DISCARD,
    discard_transport_key,
    Post,
    post,
    "/api/transport/keys/discard",
    mutation(200, Ack),
    summary = "Discard the pending PCM transport key"
);
endpoint!(
    TRANSPORT_KEY_ROLLBACK,
    rollback_transport_key,
    Post,
    post,
    "/api/transport/keys/rollback",
    mutation(200, Ack),
    summary = "Restore the previous PCM transport key"
);
endpoint!(
    TRANSPORT_KEY_RETIRE,
    retire_transport_key,
    Post,
    post,
    "/api/transport/keys/retire",
    mutation(200, Ack),
    summary = "Retire the PCM transport rollback key"
);
endpoint!(
    TRANSPORT_RECOVER,
    recover_transport,
    Post,
    post,
    "/api/transport/recover",
    mutation(200, TransportKeyResponse),
    summary = "Return to cleartext and replace an unusable pending key"
);
endpoint!(
    SET_BOARD,
    set_board,
    Post,
    post,
    "/api/settings/board",
    mutation(200, Ack),
    summary = "Select a board descriptor",
    request_body(
        content = BoardSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_AUDIO,
    set_audio,
    Post,
    post,
    "/api/settings/audio",
    mutation(200, Ack),
    summary = "Set audio levels",
    request_body(
        content = AudioSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_ANALOG_PASSTHROUGH,
    set_analog_passthrough,
    Post,
    post,
    "/api/settings/analog-passthrough",
    mutation(200, Ack),
    summary = "Set the local analog output",
    request_body(
        content = AnalogPassthroughSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_LED,
    set_led,
    Post,
    post,
    "/api/settings/led",
    mutation(200, Ack),
    summary = "Assign a role to a board LED",
    request_body(
        content = LedSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_AUDIO_PROFILES,
    set_audio_profiles,
    Post,
    post,
    "/api/settings/audio-profiles",
    mutation(200, Ack),
    summary = "Replace saved audio profiles",
    request_body(
        content = AudioProfilesSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_AUDIO_PROFILE,
    set_audio_profile,
    Post,
    post,
    "/api/settings/audio-profile",
    mutation(200, Ack),
    summary = "Activate an audio profile",
    request_body(
        content = ActiveAudioProfileRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_NAME,
    set_name,
    Post,
    post,
    "/api/settings/name",
    mutation(200, Ack),
    summary = "Set device name",
    request_body(
        content = NameSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_ADMIN_KEY,
    set_admin_key,
    Post,
    post,
    "/api/settings/admin-key",
    mutation(200, Ack),
    summary = "Replace the admin key",
    request_body(
        content = AdminKeySettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    SET_FIRMWARE,
    set_firmware,
    Post,
    post,
    "/api/settings/firmware",
    mutation(200, Ack),
    summary = "Set the automatic update schedule",
    request_body(
        content = FirmwareSettingsRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    OTA_CHECK,
    ota_check,
    Post,
    post,
    "/api/ota/check",
    mutation(202, Ack),
    summary = "Check for a firmware update"
);
endpoint!(
    OTA_UPDATE,
    ota_update,
    Post,
    post,
    "/api/ota/update",
    mutation(202, Ack),
    summary = "Install firmware",
    request_body(
        content = OtaUpdateRequest,
        content_type = "application/x-www-form-urlencoded"
    )
);
endpoint!(
    OTA_ROLLBACK,
    ota_rollback,
    Post,
    post,
    "/api/ota/rollback",
    mutation(200, Ack),
    summary = "Roll back firmware"
);
endpoint!(
    UNLOCK,
    unlock,
    Post,
    post,
    "/api/unlock",
    authenticated,
    summary = "Verify the admin key",
    responses(
        (status = 200, body = Ack),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    RESTART,
    restart,
    Post,
    post,
    "/api/restart",
    authenticated,
    summary = "Restart the device",
    responses(
        (status = 200, body = Ack),
        (status = 401, body = ErrorResponse)
    )
);
endpoint!(
    FACTORY_RESET,
    factory_reset,
    Post,
    post,
    "/api/factory-reset",
    authenticated,
    summary = "Factory-reset the device",
    responses(
        (status = 200, body = Ack),
        (status = 401, body = ErrorResponse),
        (status = 500, body = ErrorResponse)
    )
);

pub const ENDPOINTS: &[Endpoint] = &[
    STATUS,
    HEALTH,
    METRICS,
    SETTINGS,
    AUDIO_PROFILES,
    BOARDS,
    OPENAPI,
    SET_WIFI,
    SET_TARGET,
    SET_TRANSPORT,
    TRANSPORT_KEY_STAGE,
    TRANSPORT_KEY_VERIFY,
    TRANSPORT_KEY_ACTIVATE,
    TRANSPORT_KEY_DISCARD,
    TRANSPORT_KEY_ROLLBACK,
    TRANSPORT_KEY_RETIRE,
    TRANSPORT_RECOVER,
    SET_BOARD,
    SET_AUDIO,
    SET_ANALOG_PASSTHROUGH,
    SET_LED,
    SET_AUDIO_PROFILES,
    SET_AUDIO_PROFILE,
    SET_NAME,
    SET_ADMIN_KEY,
    SET_FIRMWARE,
    OTA_CHECK,
    OTA_UPDATE,
    OTA_ROLLBACK,
    UNLOCK,
    RESTART,
    FACTORY_RESET,
];

#[cfg(feature = "api-spec")]
mod spec {
    use super::*;
    use utoipa::OpenApi;

    #[derive(OpenApi)]
    #[openapi(
        info(title = "StreamLine device API", version = "2.0.0"),
        paths(get_status, get_health, get_metrics, get_settings, get_audio_profiles, get_boards, get_openapi, set_wifi, set_target, set_transport_mode, stage_transport_key, verify_transport_key, activate_transport_key, discard_transport_key, rollback_transport_key, retire_transport_key, recover_transport, set_board, set_audio, set_analog_passthrough, set_led, set_audio_profiles, set_audio_profile, set_name, set_admin_key, set_firmware, ota_check, ota_update, ota_rollback, unlock, restart, factory_reset),
        components(schemas(crate::board::Board, crate::profiles::AudioProfileCatalog)),
        modifiers(&Security)
    )]
    struct ApiDoc;

    struct Security;

    impl utoipa::Modify for Security {
        fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
            use utoipa::openapi::security::{Http, HttpAuthScheme, SecurityScheme};
            openapi
                .components
                .as_mut()
                .expect("components")
                .add_security_scheme(
                    "bearer_auth",
                    SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
                );
        }
    }

    pub fn openapi() -> utoipa::openapi::OpenApi {
        let document = ApiDoc::openapi();
        let json = serde_json::to_value(&document).expect("serializable OpenAPI");
        let paths = json["paths"].as_object().expect("OpenAPI paths");
        let operation_count: usize = paths
            .values()
            .map(|item| item.as_object().expect("path item").len())
            .sum();
        assert_eq!(operation_count, ENDPOINTS.len(), "OpenAPI operation count");
        for endpoint in ENDPOINTS {
            let verb = match endpoint.method {
                HttpMethod::Get => "get",
                HttpMethod::Post => "post",
            };
            let operation = &json["paths"][endpoint.path][verb];
            assert!(operation.is_object(), "missing {verb} {}", endpoint.path);
            assert_eq!(
                operation.get("security").is_some(),
                endpoint.auth,
                "authentication mismatch for {verb} {}",
                endpoint.path
            );
        }
        let schemas = &json["components"]["schemas"];
        assert_eq!(
            schemas["WifiSettingsRequest"]["properties"]["admin_secret"]["pattern"],
            format!("^$|{}", crate::config::ADMIN_SECRET_PATTERN)
        );
        assert_eq!(
            schemas["AdminKeySettingsRequest"]["properties"]["admin_secret"]["pattern"],
            crate::config::ADMIN_SECRET_PATTERN
        );
        assert_eq!(
            schemas["AdminKeySettingsRequest"]["properties"]["admin_secret"]["minLength"],
            crate::config::ADMIN_SECRET_HEX_CHARS
        );
        assert_eq!(
            schemas["AdminKeySettingsRequest"]["properties"]["admin_secret"]["maxLength"],
            crate::config::ADMIN_SECRET_HEX_CHARS
        );
        assert_eq!(
            schemas["NameSettingsRequest"]["properties"]["name"]["maxLength"],
            crate::config::MAX_DEVICE_NAME_CHARS
        );
        assert_eq!(
            schemas["BoardSettingsRequest"]["properties"]["descriptor"]["maxLength"],
            crate::board::MAX_DESCRIPTOR_BYTES
        );
        // Profile import limits ride the schema so clients validate against the
        // contract. These bind the emitted keywords to the model's constants.
        let profile = &schemas["AudioProfile"]["properties"];
        assert_eq!(
            profile["id"]["pattern"],
            crate::profiles::AUDIO_PROFILE_ID_PATTERN
        );
        assert_eq!(
            profile["id"]["maxLength"],
            crate::profiles::MAX_AUDIO_PROFILE_ID_CHARS
        );
        assert_eq!(
            profile["name"]["maxLength"],
            crate::profiles::MAX_AUDIO_PROFILE_NAME_CHARS
        );
        assert_eq!(
            schemas["AudioProfileCatalog"]["properties"]["profiles"]["maxItems"],
            crate::profiles::MAX_AUDIO_PROFILES
        );
        document
    }
}

#[cfg(feature = "api-spec")]
pub fn openapi_json() -> String {
    spec::openapi().to_json().expect("serializable OpenAPI")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mutation_endpoint_declares_the_complete_runtime_taxonomy() {
        use std::collections::BTreeSet;

        use crate::mutation::MutationError;

        let spec: serde_json::Value =
            serde_json::from_str(include_str!("../../../../docs/openapi.json"))
                .expect("docs/openapi.json parses");
        // The error statuses the runtime mapping can emit, straight from the
        // taxonomy, plus the adapter's auth failure.
        let mut expected_errors: BTreeSet<u16> = [
            MutationError::InvalidInput(String::new()),
            MutationError::Conflict(String::new()),
            MutationError::Unavailable(String::new()),
            MutationError::Persistence(String::new()),
            MutationError::Internal(String::new()),
        ]
        .iter()
        .map(MutationError::status)
        .collect();
        expected_errors.insert(401);

        let mut mutations = 0;
        for endpoint in ENDPOINTS {
            let ResponseContract::Mutation { success } = endpoint.contract else {
                continue;
            };
            mutations += 1;
            let declared: BTreeSet<u16> = spec["paths"][endpoint.path]["post"]["responses"]
                .as_object()
                .unwrap_or_else(|| panic!("responses for {}", endpoint.path))
                .keys()
                .map(|code| code.parse().expect("numeric status"))
                .collect();
            let mut expected = expected_errors.clone();
            expected.insert(success);
            assert_eq!(declared, expected, "response set for {}", endpoint.path);
        }
        assert!(mutations > 0, "no mutation endpoints found");
    }

    #[test]
    fn endpoint_method_and_path_pairs_are_unique() {
        for (index, endpoint) in ENDPOINTS.iter().enumerate() {
            assert!(endpoint.path.starts_with("/api/"));
            assert!(!ENDPOINTS[index + 1..]
                .iter()
                .any(|other| other.method == endpoint.method && other.path == endpoint.path));
        }
    }
}
