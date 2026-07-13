//! Board catalog and descriptor-selection handlers.

use std::sync::Arc;

use anyhow::{anyhow, bail, Result};

use crate::{api, board as board_model, profiles::AudioProfileCatalog};

use super::super::{
    auth::authorized_for,
    requests::form,
    responses::{bad_request, reboot_response, respond, serialize, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register_read(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::BOARDS, move |request| {
        respond(
            request,
            200,
            "application/json",
            &board_catalog_json(&state),
        )
    })
}

pub(super) fn register_write(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_BOARD, move |mut request| {
        if !authorized_for(&request, &state, api::SET_BOARD) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::BoardSettingsRequest = form(&mut request)?;
            let update = board_update_from_form(form, &state.board_catalog)?;
            let selected = update.board();
            let next = state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone()
                .with_audio_compatible_with(selected);

            let store = state
                .store
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?;
            if state.mode.has_persisted_configuration() {
                next.validate(selected)
                    .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
            }
            store.save_board_state(
                selected,
                matches!(&update, BoardUpdate::Custom(_)),
                state.mode.has_persisted_configuration().then_some(&next),
            )?;
            *state
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))? = next;
            *state
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))? =
                AudioProfileCatalog::empty(selected);
            Ok(())
        })();
        match result {
            Ok(()) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })
}

enum BoardUpdate {
    BuiltIn(board_model::Board),
    Custom(board_model::Board),
}

impl BoardUpdate {
    fn board(&self) -> &board_model::Board {
        match self {
            Self::BuiltIn(board) | Self::Custom(board) => board,
        }
    }
}

fn board_update_from_form(
    form: api::BoardSettingsRequest,
    catalog: &[board_model::Board],
) -> Result<BoardUpdate> {
    let board_id = form.board_id.as_deref().filter(|id| !id.is_empty());
    let descriptor_json = form
        .descriptor
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    match (board_id, descriptor_json) {
        (Some(_), Some(_)) => bail!("send either board_id or descriptor, not both"),
        (Some(id), None) => {
            let board = board_model::find(catalog, id)
                .ok_or_else(|| anyhow!("unknown board descriptor '{id}'"))?
                .clone();
            Ok(BoardUpdate::BuiltIn(board))
        }
        (None, Some(json)) => {
            if json.len() > board_model::MAX_DESCRIPTOR_BYTES {
                bail!(
                    "board descriptor is too large: {} bytes, max {}",
                    json.len(),
                    board_model::MAX_DESCRIPTOR_BYTES
                );
            }
            let board = board_model::parse_descriptor(json)
                .map_err(|error| anyhow!("invalid board descriptor: {error}"))?;
            // One id names one board. A custom descriptor may not reuse a
            // built-in id, or the boot-time selection would be ambiguous and
            // the built-in would silently shadow the upload.
            if board_model::find(catalog, &board.id).is_some() {
                bail!(
                    "board descriptor id '{}' is a built-in; choose a different id for a custom board",
                    board.id
                );
            }
            Ok(BoardUpdate::Custom(board))
        }
        (None, None) => bail!("board_id or descriptor is required"),
    }
}

fn board_catalog_json(state: &ApiState) -> String {
    let boards = state
        .board_catalog
        .iter()
        .map(api::CapabilitiesStatus::from_board)
        .collect();
    serialize(&api::BoardCatalogResponse {
        selected_board_id: state.board.id.as_str(),
        selected_board: api::CapabilitiesStatus::from_board(state.board.as_ref()),
        boards,
    })
}

#[cfg(test)]
mod tests {
    use super::{board_update_from_form, BoardUpdate};
    use crate::{api, board};

    use super::super::super::responses::serialize;

    #[test]
    fn capabilities_report_a_resolved_board_descriptor() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let board = board::resolve(&catalog, None).expect("default board");
        let json = serialize(&api::CapabilitiesStatus::from_board(board));
        assert!(json.contains(r#""board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""codec":{"driver":"es8388","i2c_address":16}"#));
        assert!(json.contains(
            r#""pins":{"i2c":{"sda":33,"scl":32},"i2s":{"mclk":0,"bclk":27,"ws":25,"din":35}}"#
        ));
    }

    #[test]
    fn board_catalog_reports_the_active_preset_and_built_ins() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let selected_board = board::resolve(&catalog, None).expect("default board");
        let boards = catalog
            .iter()
            .map(api::CapabilitiesStatus::from_board)
            .collect();
        let json = serialize(&api::BoardCatalogResponse {
            selected_board_id: selected_board.id.as_str(),
            selected_board: api::CapabilitiesStatus::from_board(selected_board),
            boards,
        });

        assert!(json.contains(r#""selected_board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json
            .contains(r#""selected_board":{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
        assert!(json.contains(r#""boards":[{"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388""#));
    }

    #[test]
    fn board_update_selects_builtin_presets() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let form = api::BoardSettingsRequest {
            board_id: Some("ai-thinker-esp32-audio-kit-v2-2-es8388".to_owned()),
            descriptor: None,
        };

        let update = board_update_from_form(form, &catalog).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::BuiltIn(_)));
        assert_eq!(update.board().id, "ai-thinker-esp32-audio-kit-v2-2-es8388");
    }

    fn descriptor_form(board: &board::Board) -> api::BoardSettingsRequest {
        api::BoardSettingsRequest {
            board_id: None,
            descriptor: Some(serde_json::to_string(board).expect("json")),
        }
    }

    #[test]
    fn board_update_accepts_custom_descriptors_with_supported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-akv22".to_owned();
        let form = descriptor_form(&custom);

        let update = board_update_from_form(form, &catalog).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::Custom(_)));
        assert_eq!(update.board().id, "custom-akv22");
    }

    #[test]
    fn board_update_rejects_custom_descriptors_reusing_a_built_in_id() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let custom = board::resolve(&catalog, None).expect("default").clone();
        let form = descriptor_form(&custom);

        let error =
            board_update_from_form(form, &catalog).expect_err("built-in id must be rejected");

        assert!(error.to_string().contains("built-in"));
    }

    #[test]
    fn board_update_rejects_custom_descriptors_with_unsupported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-unsupported".to_owned();
        custom.codec.driver = "wm8960".to_owned();
        let form = descriptor_form(&custom);

        let error =
            board_update_from_form(form, &catalog).expect_err("unsupported codec must be rejected");

        assert!(error.to_string().contains("wm8960"));
    }
}
