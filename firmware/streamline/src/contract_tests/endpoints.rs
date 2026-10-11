//! Runtime error mapping agrees with the exported operation contract.
use streamline_api::ResponseContract;
use streamline_api::ENDPOINTS;
#[test]
fn every_mutation_endpoint_declares_the_complete_runtime_taxonomy() {
    use std::collections::BTreeSet;

    use crate::mutation::MutationError;

    let spec: serde_json::Value =
        serde_json::from_str(include_str!("../../../../api/openapi.json"))
            .expect("api/openapi.json parses");
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
