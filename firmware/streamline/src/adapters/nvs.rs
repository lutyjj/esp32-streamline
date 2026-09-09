//! ESP-IDF NVS persistence for StreamLine configuration.

use anyhow::{anyhow, bail, Context, Result};
use esp_idf_svc::nvs::{EspDefaultNvs, EspDefaultNvsPartition, EspNvs};
use esp_idf_svc::{
    handle::RawHandle,
    sys::{esp, nvs_commit, nvs_set_str},
};
use std::ffi::CString;

use crate::{
    board::{self, Board, BoardSelection},
    config::{ConfigError, RuntimeConfig},
    profiles::AudioProfileCatalog,
    random::RandomBytes,
    setup_network,
    state::{GenerationStorage, PersistentState, StateStore},
};

const NAMESPACE: &str = "streamline";
const KEY_LAST_FALLBACK: &str = "last_fallback";
const KEY_LAST_OTA: &str = "last_ota";
const KEY_SETUP_AP_PASSWORD: &str = "setup_ap_pw";
/// Diagnostic notes are trimmed to fit the 256-byte read buffer.
const MAX_NOTE_BYTES: usize = 240;
/// Typed access to the two durable generations. The ESP-IDF adapter remains
/// small: portable `StateStore` owns the write ordering and recovery rule.
struct NvsGenerationStorage<'a> {
    nvs: &'a EspDefaultNvs,
}

impl GenerationStorage for NvsGenerationStorage<'_> {
    type Error = anyhow::Error;

    fn get(&self, key: &str) -> Result<Option<String>, Self::Error> {
        let capacity = match key {
            "state_a" | "state_b" => crate::state::MAX_STATE_BYTES + 1,
            "state_commit" => crate::state::MAX_MARKER_BYTES + 1,
            _ => return Err(anyhow!("unknown state key: {key}")),
        };
        if self
            .nvs
            .str_len(key)?
            .is_some_and(|length| length > capacity)
        {
            return Ok(None);
        }
        let mut buffer = vec![0_u8; capacity];
        Ok(self.nvs.get_str(key, &mut buffer)?.map(str::to_owned))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), Self::Error> {
        let key = CString::new(key)?;
        let value = CString::new(value)?;
        // EspNvs::set_str erases first; the commit pointer requires native replacement.
        esp!(unsafe { nvs_set_str(self.nvs.handle(), key.as_ptr(), value.as_ptr()) })?;
        esp!(unsafe { nvs_commit(self.nvs.handle()) })?;
        Ok(())
    }
}

/// Owns the NVS namespace and keeps the partition alive for the lifetime of
/// all reads and writes. Only the generation layout is read; a namespace
/// holding anything else opens setup.
pub struct ConfigStore {
    nvs: EspDefaultNvs,
}

impl ConfigStore {
    pub fn open(partition: EspDefaultNvsPartition) -> Result<Self> {
        Ok(Self {
            nvs: EspNvs::new(partition, NAMESPACE, true)?,
        })
    }

    fn state_store(&self) -> StateStore<NvsGenerationStorage<'_>> {
        StateStore::new(NvsGenerationStorage { nvs: &self.nvs })
    }

    fn load_state(&self) -> Result<Option<PersistentState>> {
        self.state_store()
            .load()
            .map_err(|error| anyhow!("could not load generated state: {error:?}"))
    }

    fn write_state(&self, state: PersistentState) -> Result<()> {
        self.state_store().save(&state).map_err(anyhow::Error::new)
    }

    /// The committed generation, or empty state on a device that has none.
    fn current_state(&self) -> Result<PersistentState> {
        Ok(self.load_state()?.unwrap_or_else(PersistentState::empty))
    }

    /// Commit configuration and profiles in one snapshot.
    pub fn save_configuration_and_profiles(
        &self,
        config: &RuntimeConfig,
        profiles: &AudioProfileCatalog,
        board: &Board,
    ) -> Result<()> {
        config.validate(board).map_err(config_error)?;
        profiles
            .validate(board)
            .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
        let mut state = self.current_state()?;
        state.config = Some(config.clone());
        state.profiles = Some(profiles.clone());
        if state.board_id.is_none() {
            state.board_id = Some(board.id.clone());
        }
        self.write_state(state)
    }

    /// Select a board, reset its board-bound profiles, and persist any valid
    /// configuration in one generation. `None` config keeps first-time setup
    /// unprovisioned while retaining the selected board.
    pub fn save_board_state(
        &self,
        board: &Board,
        custom: bool,
        config: Option<&RuntimeConfig>,
    ) -> Result<()> {
        board::validate_descriptor(board.clone())
            .map_err(|error| anyhow!("invalid board descriptor '{}': {error}", board.id))?;
        if let Some(config) = config {
            config.validate(board).map_err(config_error)?;
        }
        let board_descriptor = if custom {
            let descriptor = serde_json::to_string(board)?;
            if descriptor.len() > crate::board::MAX_DESCRIPTOR_BYTES {
                bail!(
                    "board descriptor is too large: {} bytes, max {}",
                    descriptor.len(),
                    crate::board::MAX_DESCRIPTOR_BYTES
                );
            }
            Some(descriptor)
        } else {
            None
        };
        self.write_state(PersistentState {
            config: config.cloned(),
            board_id: Some(board.id.clone()),
            board_descriptor,
            profiles: Some(AudioProfileCatalog::empty(board)),
        })
    }

    pub fn load_board_selection(&self, catalog: &[Board]) -> Result<BoardSelection> {
        let state = self.current_state()?;
        let selection = board::select(
            catalog,
            state.board_id.as_deref(),
            state.board_descriptor.as_deref(),
        )?;
        if let BoardSelection::Unknown { fallback, reason } = &selection {
            log::warn!("{reason}; opening setup with '{}'", fallback.id);
        }
        Ok(selection)
    }

    pub fn load(&self, board: &Board) -> Result<Option<RuntimeConfig>> {
        match self.current_state()?.config {
            Some(config) if config.validate(board).is_ok() => Ok(Some(config)),
            Some(config) => {
                log::warn!(
                    "stored configuration is invalid for board descriptor '{}': {:?}; re-commissioning",
                    board.id,
                    config.validate(board).expect_err("checked above")
                );
                Ok(None)
            }
            None => Ok(None),
        }
    }

    pub fn save(&self, config: &RuntimeConfig, board: &Board) -> Result<()> {
        config.validate(board).map_err(config_error)?;
        let mut state = self.current_state()?;
        state.config = Some(config.clone());
        if state.board_id.is_none() {
            state.board_id = Some(board.id.clone());
        }
        self.write_state(state)
    }

    pub fn load_audio_profiles(&self, board: &Board) -> Result<AudioProfileCatalog> {
        match self.current_state()?.profiles {
            Some(catalog) if catalog.validate(board).is_ok() => Ok(catalog),
            Some(catalog) => {
                log::warn!(
                    "ignoring invalid audio profile catalog: {:?}",
                    catalog.validate(board).expect_err("checked above")
                );
                Ok(AudioProfileCatalog::empty(board))
            }
            None => Ok(AudioProfileCatalog::empty(board)),
        }
    }

    pub fn save_audio_profiles(&self, catalog: &AudioProfileCatalog, board: &Board) -> Result<()> {
        catalog
            .validate(board)
            .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
        let mut state = self.current_state()?;
        state.profiles = Some(catalog.clone());
        self.write_state(state)
    }

    /// Erase the configuration and diagnostics,
    /// keeping the setup-AP password: it is device identity, minted once for
    /// the device's life, and a pre-flashed unit's label must stay true
    /// across resets.
    pub fn clear(&self) -> Result<()> {
        self.write_state(PersistentState::empty())?;
        for key in [KEY_LAST_FALLBACK, KEY_LAST_OTA] {
            if let Err(error) = self.nvs.remove(key) {
                log::warn!("could not clear reset diagnostic {key}: {error:#}");
            }
        }
        Ok(())
    }

    /// The stored setup-AP password, or mint and persist a fresh one when the
    /// stored value is absent or malformed. Only a full flash erase removes
    /// the stored value.
    pub fn ensure_setup_network_password(&self, random: &mut impl RandomBytes) -> Result<String> {
        // A read failure must not look like an absent key. `optional_string`
        // collapses both to empty, which is right for a diagnostic note and
        // wrong for a credential: regenerating on a transient error would
        // silently invalidate the password printed on the device's label.
        let mut buffer = [0_u8; 256];
        let stored = self
            .nvs
            .get_str(KEY_SETUP_AP_PASSWORD, &mut buffer)
            .context("could not read the stored setup-network password")?;
        match stored {
            Some(password) if setup_network::is_valid_password(password) => Ok(password.to_owned()),
            Some(_) => {
                log::warn!("stored setup-network password is malformed; generating a new one");
                self.generate_setup_network_password(random)
            }
            None => self.generate_setup_network_password(random),
        }
    }

    fn generate_setup_network_password(&self, random: &mut impl RandomBytes) -> Result<String> {
        let password = setup_network::generate_password(random);
        self.nvs.set_str(KEY_SETUP_AP_PASSWORD, &password)?;
        Ok(password)
    }

    /// Record why this boot fell back to the setup AP. Persisted so the
    /// evidence survives the reboot (or OTA rollback) that usually follows.
    pub fn save_last_fallback(&self, reason: &str) -> Result<()> {
        self.nvs
            .set_str(KEY_LAST_FALLBACK, truncate_utf8(reason, MAX_NOTE_BYTES))?;
        Ok(())
    }

    /// Record how the last OTA install attempt ended.
    pub fn save_last_ota(&self, outcome: &str) -> Result<()> {
        self.nvs
            .set_str(KEY_LAST_OTA, truncate_utf8(outcome, MAX_NOTE_BYTES))?;
        Ok(())
    }

    pub fn last_fallback(&self) -> String {
        self.optional_string(KEY_LAST_FALLBACK)
    }

    pub fn last_ota(&self) -> String {
        self.optional_string(KEY_LAST_OTA)
    }

    /// Best-effort string read for optional fields and diagnostic notes: a
    /// missing or unreadable value collapses to empty instead of failing.
    fn optional_string(&self, key: &str) -> String {
        let mut buffer = [0_u8; 256];
        self.nvs
            .get_str(key, &mut buffer)
            .ok()
            .flatten()
            .map(str::to_owned)
            .unwrap_or_default()
    }
}

fn config_error(error: ConfigError) -> anyhow::Error {
    anyhow::anyhow!("invalid stored configuration: {error:?}")
}

/// Truncate to at most `max` bytes without splitting a UTF-8 character.
fn truncate_utf8(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
