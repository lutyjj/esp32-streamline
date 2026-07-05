//! Built-in board descriptor catalog.

use super::{parse_descriptor, validate_catalog, Board, BoardLoadError};

pub const DEFAULT_BOARD_ID: &str = "ai-thinker-esp32-audio-kit-v2-2-es8388";

const AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388: &str =
    include_str!("../../boards/ai-thinker-esp32-audio-kit-v2-2-es8388.json");

const BUILTIN_DESCRIPTORS: &[&str] = &[AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388];

pub fn builtin_catalog() -> Result<Vec<Board>, BoardLoadError> {
    let catalog = BUILTIN_DESCRIPTORS
        .iter()
        .map(|descriptor| parse_descriptor(descriptor))
        .collect::<Result<Vec<_>, _>>()?;
    validate_catalog(&catalog)?;
    if find(&catalog, DEFAULT_BOARD_ID).is_none() {
        return Err(BoardLoadError::MissingDefault(DEFAULT_BOARD_ID.to_owned()));
    }
    Ok(catalog)
}

pub fn find<'a>(catalog: &'a [Board], id: &str) -> Option<&'a Board> {
    catalog.iter().find(|board| board.id == id)
}

pub fn resolve<'a>(catalog: &'a [Board], id: Option<&str>) -> Option<&'a Board> {
    find(catalog, id.unwrap_or(DEFAULT_BOARD_ID))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_catalog_is_coherent() {
        let catalog = builtin_catalog().expect("valid built-in board catalog");
        let default = find(&catalog, DEFAULT_BOARD_ID).expect("default board exists");

        assert!(default.accepts_line(default.default_line()));
    }

    #[test]
    fn catalog_ids_are_unique() {
        let catalog = builtin_catalog().expect("valid built-in board catalog");

        for (i, a) in catalog.iter().enumerate() {
            for b in &catalog[i + 1..] {
                assert_ne!(a.id, b.id, "board descriptor ids must be unique");
            }
        }
    }

    #[test]
    fn resolves_catalog_descriptors_by_id() {
        let catalog = builtin_catalog().expect("valid built-in board catalog");

        assert_eq!(
            resolve(&catalog, Some("ai-thinker-esp32-audio-kit-v2-2-es8388")),
            find(&catalog, DEFAULT_BOARD_ID)
        );
        assert_eq!(resolve(&catalog, None), find(&catalog, DEFAULT_BOARD_ID));
        assert_eq!(resolve(&catalog, Some("missing-board")), None);
    }
}
