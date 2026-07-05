//! Persisted board selection.
//!
//! The device stores a selected board id and, for a custom board, its
//! descriptor JSON. Which board actually drives the firmware is precedence
//! logic kept pure here so the host tests cover it; the NVS adapter only
//! reads the stored values and logs the outcome.

use super::{parse_descriptor, resolve, Board, BoardLoadError, DEFAULT_BOARD_ID};

/// The board a device boots with, given what NVS holds.
#[derive(Debug)]
pub enum BoardSelection {
    /// The stored id names a descriptor in the built-in catalog.
    BuiltIn(Board),
    /// The stored custom descriptor is selected.
    Custom(Board),
    /// Nothing stored resolves; the device opens setup with the fallback.
    Unknown { fallback: Board, reason: String },
}

impl BoardSelection {
    pub fn board(&self) -> &Board {
        match self {
            Self::BuiltIn(board) | Self::Custom(board) => board,
            Self::Unknown { fallback, .. } => fallback,
        }
    }

    pub fn is_resolved(&self) -> bool {
        matches!(self, Self::BuiltIn(_) | Self::Custom(_))
    }
}

/// Resolve the stored selection against the built-in catalog.
///
/// A stored custom descriptor wins over a built-in with the same id: the
/// descriptor key is only present while a custom board is selected, and the
/// user stored it to override whatever the firmware ships.
pub fn select(
    catalog: &[Board],
    stored_id: Option<&str>,
    custom_json: Option<&str>,
) -> Result<BoardSelection, BoardLoadError> {
    let mut unavailable = None;
    if let Some(json) = custom_json {
        match parse_descriptor(json) {
            Ok(board) if stored_id.is_none() || stored_id == Some(board.id.as_str()) => {
                return Ok(BoardSelection::Custom(board));
            }
            Ok(board) => {
                unavailable = Some(format!(
                    "stored custom board descriptor '{}' does not match selected board id '{}'",
                    board.id,
                    stored_id.unwrap_or_default()
                ));
            }
            Err(error) => {
                unavailable = Some(format!(
                    "stored custom board descriptor is invalid: {error}"
                ));
            }
        }
    }
    if let Some(board) = resolve(catalog, stored_id) {
        return Ok(BoardSelection::BuiltIn(board.clone()));
    }
    let fallback = resolve(catalog, None)
        .cloned()
        .ok_or_else(|| BoardLoadError::MissingDefault(DEFAULT_BOARD_ID.to_owned()))?;
    let reason = unavailable.unwrap_or_else(|| {
        format!(
            "stored board descriptor '{}' is not available",
            stored_id.unwrap_or_default()
        )
    });
    Ok(BoardSelection::Unknown { fallback, reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::builtin_catalog;

    fn catalog() -> Vec<Board> {
        builtin_catalog().expect("valid built-in catalog")
    }

    fn descriptor_json(board: &Board) -> String {
        serde_json::to_string(board).expect("serializable board")
    }

    #[test]
    fn a_fresh_device_selects_the_default_board() {
        let catalog = catalog();

        let selection = select(&catalog, None, None).expect("selection");

        assert!(matches!(selection, BoardSelection::BuiltIn(_)));
        assert_eq!(selection.board().id, DEFAULT_BOARD_ID);
    }

    #[test]
    fn a_stored_id_resolves_its_built_in_descriptor() {
        let catalog = catalog();

        let selection = select(&catalog, Some(DEFAULT_BOARD_ID), None).expect("selection");

        assert!(matches!(selection, BoardSelection::BuiltIn(_)));
    }

    #[test]
    fn a_stored_custom_descriptor_is_selected() {
        let catalog = catalog();
        let mut custom = catalog[0].clone();
        custom.id = "custom-akv22".to_owned();
        let json = descriptor_json(&custom);

        let selection = select(&catalog, Some("custom-akv22"), Some(&json)).expect("selection");

        match selection {
            BoardSelection::Custom(board) => assert_eq!(board, custom),
            other => panic!("expected the custom descriptor, got {other:?}"),
        }
    }

    #[test]
    fn a_custom_descriptor_wins_over_a_built_in_with_the_same_id() {
        let catalog = catalog();
        let mut custom = catalog[0].clone();
        custom.name = "same id, custom wiring".to_owned();
        custom.pins.i2c.sda = 21;
        let json = descriptor_json(&custom);

        let selection = select(&catalog, Some(custom.id.as_str()), Some(&json)).expect("selection");

        match selection {
            BoardSelection::Custom(board) => assert_eq!(board, custom),
            other => panic!("expected the custom descriptor to win, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_stored_id_falls_back_to_the_default() {
        let catalog = catalog();

        let selection = select(&catalog, Some("missing-board"), None).expect("selection");

        match selection {
            BoardSelection::Unknown { fallback, reason } => {
                assert_eq!(fallback.id, DEFAULT_BOARD_ID);
                assert!(reason.contains("missing-board"));
            }
            other => panic!("expected a fallback, got {other:?}"),
        }
    }

    #[test]
    fn an_invalid_custom_descriptor_falls_back_with_the_parse_error() {
        let catalog = catalog();

        let selection =
            select(&catalog, Some("custom-broken"), Some("{not json")).expect("selection");

        match selection {
            BoardSelection::Unknown { fallback, reason } => {
                assert_eq!(fallback.id, DEFAULT_BOARD_ID);
                assert!(reason.contains("invalid"));
            }
            other => panic!("expected a fallback, got {other:?}"),
        }
    }

    #[test]
    fn an_invalid_custom_descriptor_recovers_to_the_stored_built_in() {
        let catalog = catalog();

        let selection =
            select(&catalog, Some(DEFAULT_BOARD_ID), Some("{not json")).expect("selection");

        assert!(matches!(selection, BoardSelection::BuiltIn(_)));
    }

    #[test]
    fn a_mismatched_custom_descriptor_does_not_hijack_a_built_in_selection() {
        let catalog = catalog();
        let mut custom = catalog[0].clone();
        custom.id = "custom-other".to_owned();
        let json = descriptor_json(&custom);

        let selection = select(&catalog, Some(DEFAULT_BOARD_ID), Some(&json)).expect("selection");

        assert!(matches!(selection, BoardSelection::BuiltIn(_)));
    }
}
