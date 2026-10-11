#[cfg(test)]
mod tests {
    use streamline_api::*;

    #[test]
    fn capabilities_report_a_resolved_board_descriptor() {
        let catalog = crate::board::builtin_catalog().expect("valid catalog");
        let board = crate::board::resolve(&catalog, None).expect("default board");
        let json = serde_json::to_string(&CapabilitiesStatus::from_board(board))
            .expect("serializable capabilities");
        assert!(json.contains(r#""board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""codec":{"driver":"es8388","i2c_address":16}"#));
        assert!(json.contains(
            r#""pins":{"i2c":{"sda":33,"scl":32},"i2s":{"mclk":0,"bclk":27,"ws":25,"din":35}}"#
        ));
        assert!(json.contains(
            r#""leds":[{"id":"status","label":"Status light (D4)","gpio":22,"active_low":true,"default_role":"status"}]"#
        ));
        assert!(json.contains(
            r#""buttons":[{"id":"key1","label":"Key 1","gpio":36,"active_low":true,"default_action":"toggle_stream"}"#
        ));
        assert!(json.contains(
            r#"{"id":"key6","label":"Key 6","gpio":5,"active_low":true,"default_action":"restart"}]"#
        ));
        assert!(json.contains(r#""analog_passthrough":{"output_line":2,"label":"3.5 mm output"}"#));
    }

    #[test]
    fn board_catalog_reports_the_active_preset_and_built_ins() {
        let catalog = crate::board::builtin_catalog().expect("valid catalog");
        let selected_board = crate::board::resolve(&catalog, None).expect("default board");
        let boards = catalog.iter().map(CapabilitiesStatus::from_board).collect();
        let json = serde_json::to_string(&BoardCatalogResponse {
            selected_board_id: selected_board.id.as_str(),
            selected_board: CapabilitiesStatus::from_board(selected_board),
            boards,
        })
        .expect("serializable board catalog");

        assert!(json.contains(r#""selected_board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json
            .contains(r#""selected_board":{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""boards":[{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
    }

    #[test]
    fn acknowledgement_variants_serialize_through_one_dto() {
        assert_eq!(
            serde_json::to_string(&Ack::rebooting()).expect("serializable"),
            r#"{"ok":true,"rebooting":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Ack::started()).expect("serializable"),
            r#"{"ok":true,"started":true}"#
        );
    }
}
