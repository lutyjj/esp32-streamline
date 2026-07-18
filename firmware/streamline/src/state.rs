//! Failure-atomic persistent application state.
//!
//! A generation is written to the inactive key set and becomes visible only
//! when its marker is switched. Storage implementations make each individual
//! key durable; this module supplies the missing multi-key commit point.

use serde::{Deserialize, Serialize};

use crate::{config::RuntimeConfig, profiles::AudioProfileCatalog};

pub const STATE_SCHEMA_VERSION: u8 = 1;
pub const MAX_CONFIG_RECORD_BYTES: usize = 2_048;
pub const MAX_PROFILE_RECORD_BYTES: usize = 3_840;
pub const MAX_BOARD_DESCRIPTOR_RECORD_BYTES: usize = crate::board::MAX_DESCRIPTOR_BYTES;

const ACTIVE_GENERATION_KEY: &str = "active_gen";

/// The complete logical state that moves between durable generations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistentState {
    pub config: Option<RuntimeConfig>,
    pub board_id: Option<String>,
    /// Canonical JSON for a custom board. A built-in board stores `None`.
    pub board_descriptor: Option<String>,
    pub profiles: Option<AudioProfileCatalog>,
}

impl PersistentState {
    pub fn empty() -> Self {
        Self {
            config: None,
            board_id: None,
            board_descriptor: None,
            profiles: None,
        }
    }
}

/// A narrow storage boundary. Implementations must make one `set` durable
/// before returning successfully.
pub trait GenerationStorage {
    type Error;

    fn get(&self, key: &str) -> Result<Option<String>, Self::Error>;
    fn set(&self, key: &str, value: &str) -> Result<(), Self::Error>;
}

#[derive(Debug, Eq, PartialEq)]
pub enum StateError<E> {
    Storage(E),
    InvalidMarker,
    InvalidRecord(&'static str),
    OversizedRecord(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Generation {
    A,
    B,
}

impl Generation {
    const fn inactive(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }

    const fn marker(self) -> &'static str {
        match self {
            Self::A => "1:a",
            Self::B => "1:b",
        }
    }

    fn parse_marker(marker: &str) -> Option<Self> {
        match marker {
            "1:a" => Some(Self::A),
            "1:b" => Some(Self::B),
            _ => None,
        }
    }

    const fn config_key(self) -> &'static str {
        match self {
            Self::A => "gen_a_config",
            Self::B => "gen_b_config",
        }
    }

    const fn board_key(self) -> &'static str {
        match self {
            Self::A => "gen_a_board",
            Self::B => "gen_b_board",
        }
    }

    const fn descriptor_key(self) -> &'static str {
        match self {
            Self::A => "gen_a_desc",
            Self::B => "gen_b_desc",
        }
    }

    const fn profiles_key(self) -> &'static str {
        match self {
            Self::A => "gen_a_profiles",
            Self::B => "gen_b_profiles",
        }
    }
}

#[derive(Deserialize, Serialize)]
struct ConfigRecord {
    version: u8,
    config: Option<RuntimeConfig>,
}

#[derive(Deserialize, Serialize)]
struct BoardRecord {
    version: u8,
    board_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ProfilesRecord {
    version: u8,
    profiles: Option<AudioProfileCatalog>,
}

/// Reads and writes complete generations through one active marker.
pub struct StateStore<S> {
    storage: S,
}

impl<S> StateStore<S> {
    pub const fn new(storage: S) -> Self {
        Self { storage }
    }

    pub fn into_inner(self) -> S {
        self.storage
    }
}

impl<S: GenerationStorage> StateStore<S> {
    pub fn load(&self) -> Result<Option<PersistentState>, StateError<S::Error>> {
        let Some(marker) = self
            .storage
            .get(ACTIVE_GENERATION_KEY)
            .map_err(StateError::Storage)?
        else {
            return Ok(None);
        };
        let generation = Generation::parse_marker(&marker).ok_or(StateError::InvalidMarker)?;
        self.read_generation(generation).map(Some)
    }

    /// Write every record to the inactive generation, then switch the one
    /// marker readers consult. An error leaves the previous active generation
    /// selected, so callers must update memory only after this returns `Ok`.
    pub fn save(&self, state: &PersistentState) -> Result<(), StateError<S::Error>> {
        let inactive = match self
            .storage
            .get(ACTIVE_GENERATION_KEY)
            .map_err(StateError::Storage)?
        {
            None => Generation::A,
            Some(marker) => Generation::parse_marker(&marker)
                .ok_or(StateError::InvalidMarker)?
                .inactive(),
        };
        let config = encode(
            "configuration",
            &ConfigRecord {
                version: STATE_SCHEMA_VERSION,
                config: state.config.clone(),
            },
            MAX_CONFIG_RECORD_BYTES,
        )?;
        let board = encode(
            "board",
            &BoardRecord {
                version: STATE_SCHEMA_VERSION,
                board_id: state.board_id.clone(),
            },
            MAX_CONFIG_RECORD_BYTES,
        )?;
        let profiles = encode(
            "profiles",
            &ProfilesRecord {
                version: STATE_SCHEMA_VERSION,
                profiles: state.profiles.clone(),
            },
            MAX_PROFILE_RECORD_BYTES,
        )?;
        let descriptor = state.board_descriptor.as_deref().unwrap_or_default();
        if descriptor.len() > MAX_BOARD_DESCRIPTOR_RECORD_BYTES {
            return Err(StateError::OversizedRecord("board descriptor"));
        }

        self.storage
            .set(inactive.config_key(), &config)
            .map_err(StateError::Storage)?;
        self.storage
            .set(inactive.board_key(), &board)
            .map_err(StateError::Storage)?;
        self.storage
            .set(inactive.descriptor_key(), descriptor)
            .map_err(StateError::Storage)?;
        self.storage
            .set(inactive.profiles_key(), &profiles)
            .map_err(StateError::Storage)?;
        self.storage
            .set(ACTIVE_GENERATION_KEY, inactive.marker())
            .map_err(StateError::Storage)
    }

    fn read_generation(
        &self,
        generation: Generation,
    ) -> Result<PersistentState, StateError<S::Error>> {
        let config = self.required(generation.config_key(), "configuration")?;
        let board = self.required(generation.board_key(), "board")?;
        let descriptor = self
            .storage
            .get(generation.descriptor_key())
            .map_err(StateError::Storage)?
            .ok_or(StateError::InvalidRecord("board descriptor"))?;
        let profiles = self.required(generation.profiles_key(), "profiles")?;
        let config: ConfigRecord = decode("configuration", &config)?;
        let board: BoardRecord = decode("board", &board)?;
        let profiles: ProfilesRecord = decode("profiles", &profiles)?;
        if config.version != STATE_SCHEMA_VERSION
            || board.version != STATE_SCHEMA_VERSION
            || profiles.version != STATE_SCHEMA_VERSION
        {
            return Err(StateError::InvalidRecord("state schema"));
        }
        if descriptor.len() > MAX_BOARD_DESCRIPTOR_RECORD_BYTES {
            return Err(StateError::OversizedRecord("board descriptor"));
        }
        Ok(PersistentState {
            config: config.config,
            board_id: board.board_id,
            board_descriptor: (!descriptor.is_empty()).then_some(descriptor),
            profiles: profiles.profiles,
        })
    }

    fn required(&self, key: &str, record: &'static str) -> Result<String, StateError<S::Error>> {
        self.storage
            .get(key)
            .map_err(StateError::Storage)?
            .ok_or(StateError::InvalidRecord(record))
    }
}

fn encode<T: Serialize, E>(
    record: &'static str,
    value: &T,
    maximum: usize,
) -> Result<String, StateError<E>> {
    let encoded = serde_json::to_string(value).map_err(|_| StateError::InvalidRecord(record))?;
    if encoded.len() > maximum {
        return Err(StateError::OversizedRecord(record));
    }
    Ok(encoded)
}

fn decode<T: for<'de> Deserialize<'de>, E>(
    record: &'static str,
    value: &str,
) -> Result<T, StateError<E>> {
    serde_json::from_str(value).map_err(|_| StateError::InvalidRecord(record))
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::BTreeMap};

    use super::*;
    use crate::{
        board,
        config::{AudioSettings, AutoUpdateSchedule},
        profiles::{AudioProfile, AUDIO_PROFILE_SCHEMA_VERSION},
        transport::{RandomBytes, TransportMode},
    };

    struct Sequence(u8);

    impl RandomBytes for Sequence {
        fn fill(&mut self, output: &mut [u8]) {
            for byte in output {
                *byte = self.0;
                self.0 = self.0.wrapping_add(1);
            }
        }
    }

    #[derive(Default)]
    struct FakeStorage {
        values: RefCell<BTreeMap<String, String>>,
        fail_after: RefCell<Option<usize>>,
        writes: RefCell<usize>,
    }

    impl FakeStorage {
        fn interrupted_after(writes: usize) -> Self {
            Self {
                fail_after: RefCell::new(Some(writes)),
                ..Self::default()
            }
        }

        fn from_values(values: BTreeMap<String, String>, fail_after: usize) -> Self {
            Self {
                values: RefCell::new(values),
                fail_after: RefCell::new(Some(fail_after)),
                writes: RefCell::new(0),
            }
        }

        fn values(&self) -> BTreeMap<String, String> {
            self.values.borrow().clone()
        }
    }

    impl GenerationStorage for FakeStorage {
        type Error = &'static str;

        fn get(&self, key: &str) -> Result<Option<String>, Self::Error> {
            Ok(self.values.borrow().get(key).cloned())
        }

        fn set(&self, key: &str, value: &str) -> Result<(), Self::Error> {
            let mut writes = self.writes.borrow_mut();
            *writes += 1;
            if self
                .fail_after
                .borrow()
                .is_some_and(|boundary| *writes == boundary)
            {
                return Err("interrupted");
            }
            self.values
                .borrow_mut()
                .insert(key.to_owned(), value.to_owned());
            Ok(())
        }
    }

    fn state(name: &str) -> PersistentState {
        let board = board::builtin_catalog().expect("catalog").remove(0);
        PersistentState {
            config: Some(RuntimeConfig {
                ssid: name.to_owned(),
                password: format!("{name}-password"),
                target_host: "bridge.local".to_owned(),
                target_port: 39_000,
                transport: Default::default(),
                admin_secret: crate::config::TEST_ADMIN_SECRET.to_owned(),
                device_name: name.to_owned(),
                auto_update_schedule: AutoUpdateSchedule::Daily,
                audio: AudioSettings {
                    input_line: 2,
                    input_gain: 10,
                    adc_attenuation_db: 3,
                },
                analog_passthrough_enabled: true,
                led_roles: std::collections::BTreeMap::from([(
                    "status".to_owned(),
                    crate::led::LedRole::On,
                )]),
            }),
            board_id: Some(board.id.clone()),
            board_descriptor: None,
            profiles: Some(AudioProfileCatalog {
                schema_version: AUDIO_PROFILE_SCHEMA_VERSION,
                board_id: board.id,
                active_profile_id: Some("turntable".to_owned()),
                profiles: vec![AudioProfile {
                    id: "turntable".to_owned(),
                    name: "Turntable".to_owned(),
                    audio: AudioSettings {
                        input_line: 1,
                        input_gain: 20,
                        adc_attenuation_db: 6,
                    },
                }],
            }),
        }
    }

    #[test]
    fn switches_complete_generations() {
        let storage = FakeStorage::default();
        let store = StateStore::new(storage);
        let first = state("first");
        let second = state("second");

        store.save(&first).expect("first state saves");
        assert_eq!(store.load(), Ok(Some(first)));
        store.save(&second).expect("second state saves");
        assert_eq!(store.load(), Ok(Some(second)));
    }

    #[test]
    fn interruption_at_every_write_boundary_keeps_the_previous_generation() {
        let initial_storage = FakeStorage::default();
        let initial_store = StateStore::new(initial_storage);
        let before = state("before");
        initial_store.save(&before).expect("initial save");
        let values = initial_store.into_inner().values();
        let after = state("after");

        for boundary in 1..=5 {
            let storage = FakeStorage::from_values(values.clone(), boundary);
            let store = StateStore::new(storage);
            assert_eq!(store.save(&after), Err(StateError::Storage("interrupted")));
            assert_eq!(
                store.load(),
                Ok(Some(before.clone())),
                "boundary {boundary}"
            );
        }
    }

    #[test]
    fn every_transport_key_transition_is_failure_atomic_at_every_write_boundary() {
        let cleartext = state("transport-device");
        let mut staged = cleartext.clone();
        staged
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .stage(&mut Sequence(0))
            .expect("stage first key");
        let mut verified = staged.clone();
        verified
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .mark_pending_verified()
            .expect("verify first key");
        let mut activated = verified.clone();
        let active_transport = &mut activated.config.as_mut().expect("config").transport;
        active_transport
            .keys
            .activate()
            .expect("activate first key");
        active_transport.mode = TransportMode::TlsPsk;

        let mut rotation_staged = activated.clone();
        rotation_staged
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .stage(&mut Sequence(64))
            .expect("stage rotation key");
        let mut rotation_verified = rotation_staged.clone();
        rotation_verified
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .mark_pending_verified()
            .expect("verify rotation key");
        let mut rotated = rotation_verified.clone();
        rotated
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .activate()
            .expect("activate rotation key");
        let mut rolled_back = rotated.clone();
        rolled_back
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .rollback_key()
            .expect("roll back key");
        let mut retired = rolled_back.clone();
        retired
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .retire_rollback()
            .expect("retire rollback key");
        let mut recovered = rotation_staged.clone();
        recovered.config.as_mut().expect("config").transport.mode = TransportMode::Cleartext;
        recovered
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .recover(&mut Sequence(128))
            .expect("recover key");

        let mut discarded = rotation_staged.clone();
        discarded
            .config
            .as_mut()
            .expect("config")
            .transport
            .keys
            .discard_pending()
            .expect("discard pending key");
        assert_eq!(discarded, activated);

        let transitions = [
            ("stage", &cleartext, &staged),
            ("verify", &staged, &verified),
            ("activate", &verified, &activated),
            ("rotation stage", &activated, &rotation_staged),
            ("rotation verify", &rotation_staged, &rotation_verified),
            ("rotation activate", &rotation_verified, &rotated),
            ("rollback", &rotated, &rolled_back),
            ("retire", &rolled_back, &retired),
            ("discard", &rotation_staged, &discarded),
            ("recovery", &rotation_staged, &recovered),
        ];

        for (transition, before, after) in transitions {
            let initial_store = StateStore::new(FakeStorage::default());
            initial_store.save(before).expect("save starting state");
            let values = initial_store.into_inner().values();

            for boundary in 1..=5 {
                let store = StateStore::new(FakeStorage::from_values(values.clone(), boundary));
                assert_eq!(store.save(after), Err(StateError::Storage("interrupted")));
                assert_eq!(
                    store.load(),
                    Ok(Some(before.clone())),
                    "{transition} at boundary {boundary}"
                );
            }
        }
    }

    #[test]
    fn first_generation_stays_unconfigured_until_its_marker_commits() {
        let next = state("first");
        for boundary in 1..=5 {
            let store = StateStore::new(FakeStorage::interrupted_after(boundary));
            assert_eq!(store.save(&next), Err(StateError::Storage("interrupted")));
            assert_eq!(store.load(), Ok(None), "boundary {boundary}");
        }
    }

    #[test]
    fn reset_is_a_complete_empty_generation() {
        let storage = FakeStorage::default();
        let store = StateStore::new(storage);
        let configured = state("configured");
        store.save(&configured).expect("configured state");
        let values = store.into_inner().values();

        for boundary in 1..=5 {
            let store = StateStore::new(FakeStorage::from_values(values.clone(), boundary));
            assert_eq!(
                store.save(&PersistentState::empty()),
                Err(StateError::Storage("interrupted"))
            );
            assert_eq!(
                store.load(),
                Ok(Some(configured.clone())),
                "boundary {boundary}"
            );
        }
    }

    #[test]
    fn corrupt_marker_is_an_error_not_a_guess() {
        let store = StateStore::new(FakeStorage::default());
        store.save(&state("first")).expect("state saves");
        let mut values = store.into_inner().values();
        values.insert(ACTIVE_GENERATION_KEY.to_owned(), "9:z".to_owned());

        let corrupted = StateStore::new(FakeStorage::from_values(values, usize::MAX));
        assert_eq!(corrupted.load(), Err(StateError::InvalidMarker));
    }

    #[test]
    fn missing_record_in_the_active_generation_is_an_error() {
        let store = StateStore::new(FakeStorage::default());
        store.save(&state("first")).expect("state saves");
        let mut values = store.into_inner().values();
        let config_key = values
            .keys()
            .find(|key| key.contains("config"))
            .expect("a config record exists")
            .clone();
        values.remove(&config_key);

        let truncated = StateStore::new(FakeStorage::from_values(values, usize::MAX));
        assert_eq!(
            truncated.load(),
            Err(StateError::InvalidRecord("configuration"))
        );
    }

    #[test]
    fn oversized_descriptor_is_rejected_before_any_write() {
        let store = StateStore::new(FakeStorage::default());
        store.save(&state("first")).expect("state saves");
        let before = StateStore::new(FakeStorage::from_values(
            store.into_inner().values(),
            usize::MAX,
        ));

        let mut oversized = state("second");
        oversized.board_descriptor = Some("x".repeat(MAX_BOARD_DESCRIPTOR_RECORD_BYTES + 1));
        assert_eq!(
            before.save(&oversized),
            Err(StateError::OversizedRecord("board descriptor"))
        );
        assert_eq!(
            before.load(),
            Ok(Some(state("first"))),
            "a rejected save must leave the active generation untouched"
        );
    }
}
