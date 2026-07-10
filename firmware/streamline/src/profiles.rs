//! Named, portable audio-setting profiles.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    board::Board,
    config::{AudioSettings, ConfigError},
};

pub const AUDIO_PROFILE_SCHEMA_VERSION: u8 = 1;
pub const MAX_AUDIO_PROFILES: usize = 8;
pub const MAX_AUDIO_PROFILE_ID_CHARS: usize = 32;
pub const MAX_AUDIO_PROFILE_NAME_CHARS: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioProfile {
    pub id: String,
    pub name: String,
    pub audio: AudioSettings,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct AudioProfileCatalog {
    pub schema_version: u8,
    pub board_id: String,
    pub active_profile_id: Option<String>,
    pub profiles: Vec<AudioProfile>,
}

impl AudioProfileCatalog {
    pub fn empty(board: &Board) -> Self {
        Self {
            schema_version: AUDIO_PROFILE_SCHEMA_VERSION,
            board_id: board.id.clone(),
            active_profile_id: None,
            profiles: Vec::new(),
        }
    }

    pub fn validate(&self, board: &Board) -> Result<(), AudioProfileError> {
        if self.schema_version != AUDIO_PROFILE_SCHEMA_VERSION {
            return Err(AudioProfileError::UnsupportedSchema);
        }
        if self.board_id != board.id {
            return Err(AudioProfileError::WrongBoard);
        }
        if self.profiles.len() > MAX_AUDIO_PROFILES {
            return Err(AudioProfileError::TooManyProfiles);
        }

        let mut ids = BTreeSet::new();
        for profile in &self.profiles {
            profile.validate(board)?;
            if !ids.insert(profile.id.as_str()) {
                return Err(AudioProfileError::DuplicateId);
            }
        }
        if self
            .active_profile_id
            .as_deref()
            .is_some_and(|id| !ids.contains(id))
        {
            return Err(AudioProfileError::UnknownActiveProfile);
        }
        Ok(())
    }

    pub fn active_audio(&self) -> Option<AudioSettings> {
        let active = self.active_profile_id.as_deref()?;
        self.profiles
            .iter()
            .find(|profile| profile.id == active)
            .map(|profile| profile.audio)
    }

    pub fn activate(
        &mut self,
        id: Option<&str>,
    ) -> Result<Option<AudioSettings>, AudioProfileError> {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            self.active_profile_id = None;
            return Ok(None);
        };
        let profile = self
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .ok_or(AudioProfileError::UnknownActiveProfile)?;
        self.active_profile_id = Some(profile.id.clone());
        Ok(Some(profile.audio))
    }

    /// A selected profile only remains active while its settings are the ones
    /// actually applied. This repairs interrupted multi-key NVS writes and any
    /// store whose active marker diverges from the applied settings.
    pub fn reconcile_active_audio(&mut self, current: AudioSettings) {
        if self.active_audio().is_some_and(|audio| audio != current) {
            self.active_profile_id = None;
        }
    }
}

impl AudioProfile {
    pub fn validate(&self, board: &Board) -> Result<(), AudioProfileError> {
        let valid_id = !self.id.is_empty()
            && self.id.len() <= MAX_AUDIO_PROFILE_ID_CHARS
            && self.id.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
            });
        if !valid_id {
            return Err(AudioProfileError::InvalidId);
        }
        if self.name.trim().is_empty()
            || self.name.trim() != self.name
            || self.name.chars().count() > MAX_AUDIO_PROFILE_NAME_CHARS
        {
            return Err(AudioProfileError::InvalidName);
        }
        self.audio
            .validate(board)
            .map_err(AudioProfileError::InvalidAudio)?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AudioProfileError {
    UnsupportedSchema,
    WrongBoard,
    TooManyProfiles,
    DuplicateId,
    InvalidId,
    InvalidName,
    InvalidAudio(ConfigError),
    UnknownActiveProfile,
}

#[cfg(test)]
mod tests {
    use super::{AudioProfile, AudioProfileCatalog, AudioProfileError, MAX_AUDIO_PROFILES};
    use crate::{board, config::AudioSettings};

    fn board() -> board::Board {
        let catalog = board::builtin_catalog().expect("valid catalog");
        board::resolve(&catalog, None)
            .expect("default board")
            .clone()
    }

    fn profile(id: &str, name: &str, attenuation: u8) -> AudioProfile {
        AudioProfile {
            id: id.to_owned(),
            name: name.to_owned(),
            audio: AudioSettings {
                input_line: 2,
                input_gain: 0,
                adc_attenuation_db: attenuation,
            },
        }
    }

    #[test]
    fn validates_a_board_bound_catalog() {
        let board = board();
        let catalog = AudioProfileCatalog {
            schema_version: 1,
            board_id: board.id.clone(),
            active_profile_id: Some("vinyl".to_owned()),
            profiles: vec![profile("cd", "CD player", 3), profile("vinyl", "Vinyl", 12)],
        };

        assert_eq!(catalog.validate(&board), Ok(()));
        assert_eq!(
            catalog.active_audio(),
            Some(profile("vinyl", "Vinyl", 12).audio)
        );
        let json = serde_json::to_string(&catalog).expect("serializable catalog");
        assert_eq!(
            serde_json::from_str::<AudioProfileCatalog>(&json).expect("round trip"),
            catalog
        );
    }

    #[test]
    fn rejects_unknown_contract_fields() {
        let json = r#"{
            "schema_version":1,
            "board_id":"board-a",
            "active_profile_id":null,
            "profiles":[],
            "trigger":"guess-from-audio"
        }"#;

        assert!(serde_json::from_str::<AudioProfileCatalog>(json).is_err());
    }

    #[test]
    fn rejects_ambiguous_or_unportable_catalogs() {
        let board = board();
        let mut catalog = AudioProfileCatalog::empty(&board);
        catalog.profiles = vec![profile("vinyl", "Vinyl", 12), profile("vinyl", "Other", 3)];
        assert_eq!(
            catalog.validate(&board),
            Err(AudioProfileError::DuplicateId)
        );

        catalog.profiles = vec![profile("Vinyl 1", "Vinyl", 12)];
        assert_eq!(catalog.validate(&board), Err(AudioProfileError::InvalidId));

        catalog.profiles = vec![profile("vinyl", " Vinyl ", 12)];
        assert_eq!(
            catalog.validate(&board),
            Err(AudioProfileError::InvalidName)
        );

        catalog.profiles = (0..=MAX_AUDIO_PROFILES)
            .map(|index| profile(&format!("profile-{index}"), "Source", 0))
            .collect();
        assert_eq!(
            catalog.validate(&board),
            Err(AudioProfileError::TooManyProfiles)
        );
    }

    #[test]
    fn activation_is_named_and_can_return_to_custom_settings() {
        let board = board();
        let mut catalog = AudioProfileCatalog::empty(&board);
        catalog.profiles.push(profile("cd", "CD player", 3));

        assert_eq!(
            catalog.activate(Some("cd")),
            Ok(Some(profile("cd", "CD player", 3).audio))
        );
        assert_eq!(catalog.active_profile_id.as_deref(), Some("cd"));
        assert_eq!(
            catalog.activate(Some("missing")),
            Err(AudioProfileError::UnknownActiveProfile)
        );
        assert_eq!(catalog.activate(None), Ok(None));
        assert_eq!(catalog.active_profile_id, None);
    }

    #[test]
    fn reconciles_a_stale_active_marker_with_applied_audio() {
        let board = board();
        let mut catalog = AudioProfileCatalog::empty(&board);
        catalog.profiles.push(profile("vinyl", "Vinyl", 12));
        catalog.active_profile_id = Some("vinyl".to_owned());

        catalog.reconcile_active_audio(profile("vinyl", "Vinyl", 3).audio);

        assert_eq!(catalog.active_profile_id, None);
    }
}
