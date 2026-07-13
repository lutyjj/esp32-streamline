//! Board selection update policy.

use std::fmt;

use super::{find, parse_descriptor, Board, BoardLoadError, MAX_DESCRIPTOR_BYTES};

#[derive(Debug)]
pub enum BoardUpdate {
    BuiltIn(Board),
    Custom(Board),
}

impl BoardUpdate {
    pub fn board(&self) -> &Board {
        match self {
            Self::BuiltIn(board) | Self::Custom(board) => board,
        }
    }

    pub const fn is_custom(&self) -> bool {
        matches!(self, Self::Custom(_))
    }
}

#[derive(Debug)]
pub enum BoardUpdateError {
    ConflictingSelection,
    UnknownBoard(String),
    DescriptorTooLarge { actual: usize, max: usize },
    InvalidDescriptor(BoardLoadError),
    BuiltInId(String),
    MissingSelection,
}

impl fmt::Display for BoardUpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ConflictingSelection => {
                write!(f, "send either board_id or descriptor, not both")
            }
            Self::UnknownBoard(id) => write!(f, "unknown board descriptor '{id}'"),
            Self::DescriptorTooLarge { actual, max } => {
                write!(
                    f,
                    "board descriptor is too large: {actual} bytes, max {max}"
                )
            }
            Self::InvalidDescriptor(error) => write!(f, "invalid board descriptor: {error}"),
            Self::BuiltInId(id) => write!(
                f,
                "board descriptor id '{id}' is a built-in; choose a different id for a custom board"
            ),
            Self::MissingSelection => write!(f, "board_id or descriptor is required"),
        }
    }
}

impl std::error::Error for BoardUpdateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidDescriptor(error) => Some(error),
            _ => None,
        }
    }
}

pub fn resolve_update(
    catalog: &[Board],
    board_id: Option<&str>,
    descriptor_json: Option<&str>,
) -> Result<BoardUpdate, BoardUpdateError> {
    let board_id = board_id.filter(|id| !id.is_empty());
    let descriptor_json = descriptor_json
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    match (board_id, descriptor_json) {
        (Some(_), Some(_)) => Err(BoardUpdateError::ConflictingSelection),
        (Some(id), None) => find(catalog, id)
            .cloned()
            .map(BoardUpdate::BuiltIn)
            .ok_or_else(|| BoardUpdateError::UnknownBoard(id.to_owned())),
        (None, Some(json)) => {
            if json.len() > MAX_DESCRIPTOR_BYTES {
                return Err(BoardUpdateError::DescriptorTooLarge {
                    actual: json.len(),
                    max: MAX_DESCRIPTOR_BYTES,
                });
            }
            let board = parse_descriptor(json).map_err(BoardUpdateError::InvalidDescriptor)?;
            // One id names one board. A custom descriptor may not reuse a
            // built-in id, or boot-time selection would be ambiguous.
            if find(catalog, &board.id).is_some() {
                return Err(BoardUpdateError::BuiltInId(board.id));
            }
            Ok(BoardUpdate::Custom(board))
        }
        (None, None) => Err(BoardUpdateError::MissingSelection),
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_update, BoardUpdate, BoardUpdateError};
    use crate::{
        board::{self, BoardLoadError},
        codec::CodecError,
    };

    #[test]
    fn selects_builtin_presets() {
        let catalog = board::builtin_catalog().expect("valid catalog");

        let update = resolve_update(
            &catalog,
            Some("ai-thinker-esp32-audio-kit-v2-2-es8388"),
            None,
        )
        .expect("valid board update");

        assert!(matches!(&update, BoardUpdate::BuiltIn(_)));
        assert_eq!(update.board().id, "ai-thinker-esp32-audio-kit-v2-2-es8388");
    }

    fn descriptor(board: &board::Board) -> String {
        serde_json::to_string(board).expect("json")
    }

    #[test]
    fn accepts_custom_descriptors_with_supported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-akv22".to_owned();
        let json = descriptor(&custom);

        let update = resolve_update(&catalog, None, Some(&json)).expect("valid board update");

        assert!(matches!(&update, BoardUpdate::Custom(_)));
        assert_eq!(update.board().id, "custom-akv22");
    }

    #[test]
    fn rejects_custom_descriptors_reusing_a_built_in_id() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let custom = board::resolve(&catalog, None).expect("default").clone();
        let json = descriptor(&custom);

        let error =
            resolve_update(&catalog, None, Some(&json)).expect_err("built-in id must be rejected");

        assert!(error.to_string().contains("built-in"));
    }

    #[test]
    fn rejects_custom_descriptors_with_unsupported_codecs() {
        let catalog = board::builtin_catalog().expect("valid catalog");
        let mut custom = board::resolve(&catalog, None).expect("default").clone();
        custom.id = "custom-unsupported".to_owned();
        custom.codec.driver = "wm8960".to_owned();
        let json = descriptor(&custom);

        let error = resolve_update(&catalog, None, Some(&json))
            .expect_err("unsupported codec must be rejected");

        assert!(matches!(
            error,
            BoardUpdateError::InvalidDescriptor(BoardLoadError::UnsupportedCodec {
                error: CodecError::UnsupportedDriver,
                ..
            })
        ));
    }
}
