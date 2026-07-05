//! Official board preset descriptors.

use super::{Board, CodecDriverId, CodecSpec, I2cPins, I2sPins, InputOption, PinMap};

/// Built-in preset used when no board has been selected yet.
pub const DEFAULT_PRESET: &Board<'static> = &AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388;

/// Built-in board presets compiled into this firmware image.
pub const CATALOG: &[&Board<'static>] = &[&AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388];

/// Find a built-in board preset by its stable id.
pub fn find_preset(id: &str) -> Option<&'static Board<'static>> {
    CATALOG.iter().copied().find(|board| board.id == id)
}

/// Resolve a persisted built-in preset id, falling back to the default preset
/// when the device has not stored a board selection yet.
pub fn resolve_preset(id: Option<&str>) -> Option<&'static Board<'static>> {
    match id {
        Some(id) => find_preset(id),
        None => Some(DEFAULT_PRESET),
    }
}

/// Ai-Thinker ESP32 Audio Kit v2.2 (ES8388 codec).
pub const AI_THINKER_ESP32_AUDIO_KIT_V2_2_ES8388: Board<'static> = Board {
    id: "ai-thinker-esp32-audio-kit-v2-2-es8388",
    name: "Ai-Thinker ESP32 Audio Kit v2.2 (ES8388)",
    codec: CodecSpec {
        driver: CodecDriverId::ES8388,
        i2c_address: 0x10,
    },
    pins: PinMap {
        i2c: I2cPins { sda: 33, scl: 32 },
        i2s: I2sPins {
            mclk: 0,
            bclk: 27,
            ws: 25,
            din: 35,
        },
    },
    input_lines: &[
        InputOption {
            line: 2,
            label: "Line 2 — 3.5 mm jack",
        },
        InputOption {
            line: 1,
            label: "Line 1 — header pins",
        },
    ],
    input_gain_max: 100,
    adc_atten_max_db: 48,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_preset_is_coherent() {
        assert_eq!(DEFAULT_PRESET.validate(), Ok(()));
        assert!(DEFAULT_PRESET.accepts_line(DEFAULT_PRESET.default_line()));
    }

    #[test]
    fn catalog_ids_are_unique() {
        for (i, a) in CATALOG.iter().enumerate() {
            for b in &CATALOG[i + 1..] {
                assert_ne!(a.id, b.id, "board preset ids must be unique");
            }
        }
    }

    #[test]
    fn resolves_catalog_presets_by_id() {
        assert_eq!(
            resolve_preset(Some("ai-thinker-esp32-audio-kit-v2-2-es8388")),
            Some(DEFAULT_PRESET)
        );
        assert_eq!(resolve_preset(None), Some(DEFAULT_PRESET));
        assert_eq!(resolve_preset(Some("missing-board")), None);
    }
}
