//! Bounded, failure-atomic configuration snapshots with committed fallback.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{config::RuntimeConfig, profiles::AudioProfileCatalog};

/// One NVS string fits one page, leaving pages for replacement and Wi-Fi state.
pub const MAX_STATE_BYTES: usize = 3_840;
pub const MAX_MARKER_BYTES: usize = 256;
const COMMIT_KEY: &str = "state_commit";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PersistentState {
    pub config: Option<RuntimeConfig>,
    pub board_id: Option<String>,
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

/// Each successful set is durable and atomic, including replacement of a key.
pub trait GenerationStorage {
    type Error;

    fn get(&self, key: &str) -> Result<Option<String>, Self::Error>;
    fn set(&self, key: &str, value: &str) -> Result<(), Self::Error>;
}

#[derive(Debug, Eq, PartialEq)]
pub enum StateError<E> {
    Storage(E),
    InvalidRecord,
    OversizedState,
}

impl<E: std::fmt::Display> std::fmt::Display for StateError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(error) => write!(formatter, "configuration storage failed: {error}"),
            Self::InvalidRecord => formatter.write_str("invalid configuration snapshot"),
            Self::OversizedState => write!(
                formatter,
                "complete configuration exceeds the {MAX_STATE_BYTES}-byte storage budget"
            ),
        }
    }
}

impl<E: std::fmt::Debug + std::fmt::Display> std::error::Error for StateError<E> {}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize)]
enum Slot {
    A,
    B,
}

impl Slot {
    fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::A => "state_a",
            Self::B => "state_b",
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    slot: Slot,
    sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    active: Snapshot,
    previous: Option<Snapshot>,
}

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
        Ok(self.committed()?.map(|(_, state)| state))
    }

    pub fn save(&self, state: &PersistentState) -> Result<(), StateError<S::Error>> {
        let encoded = serde_json::to_string(state).map_err(|_| StateError::InvalidRecord)?;
        if encoded.len() > MAX_STATE_BYTES {
            return Err(StateError::OversizedState);
        }
        let current = self.committed()?;
        let slot = current
            .as_ref()
            .map_or(Slot::A, |(snapshot, _)| snapshot.slot.other());
        let commit = Commit {
            active: Snapshot {
                slot,
                sha256: checksum(&encoded),
            },
            // Reset must never restore the credentials it deliberately removed.
            previous: current
                .filter(|(_, previous)| state.config.is_some() && previous.config.is_some())
                .map(|(snapshot, _)| snapshot),
        };
        let marker = serde_json::to_string(&commit).map_err(|_| StateError::InvalidRecord)?;
        self.storage
            .set(slot.key(), &encoded)
            .map_err(StateError::Storage)?;
        self.storage
            .set(COMMIT_KEY, &marker)
            .map_err(StateError::Storage)
    }

    fn committed(&self) -> Result<Option<(Snapshot, PersistentState)>, StateError<S::Error>> {
        let Some(marker) = self.storage.get(COMMIT_KEY).map_err(StateError::Storage)? else {
            return Ok(None);
        };
        if marker.len() > MAX_MARKER_BYTES {
            return Ok(None);
        }
        let Ok(commit) = serde_json::from_str::<Commit>(&marker) else {
            return Ok(None);
        };
        for snapshot in std::iter::once(commit.active).chain(commit.previous) {
            let Some(value) = self
                .storage
                .get(snapshot.slot.key())
                .map_err(StateError::Storage)?
            else {
                continue;
            };
            if value.len() > MAX_STATE_BYTES || checksum(&value) != snapshot.sha256 {
                continue;
            }
            if let Ok(state) = serde_json::from_str(&value) {
                return Ok(Some((snapshot, state)));
            }
        }
        Ok(None)
    }
}

fn checksum(value: &str) -> String {
    crate::hex::encode(&Sha256::digest(value.as_bytes()))
}
#[cfg(test)]
mod tests {
    use std::{cell::RefCell, collections::BTreeMap};

    use super::*;
    use crate::{
        board,
        config::{AudioSettings, AutoUpdateSchedule},
        profiles::{AudioProfile, AUDIO_PROFILE_SCHEMA_VERSION},
        random::RandomBytes,
        transport::TransportMode,
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
                admin_key: crate::config::TEST_ADMIN_KEY.to_owned(),
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
                button_actions: std::collections::BTreeMap::from([(
                    "key1".to_owned(),
                    crate::button::ButtonAction::FactoryReset,
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

        for boundary in 1..=2 {
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

            for boundary in 1..=2 {
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
        for boundary in 1..=2 {
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

        for boundary in 1..=2 {
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
    fn corrupt_active_falls_back_and_next_save_preserves_that_fallback() {
        let store = StateStore::new(FakeStorage::default());
        let before = state("before");
        store.save(&before).unwrap();
        store.save(&state("after")).unwrap();
        store
            .storage
            .values
            .borrow_mut()
            .insert("state_b".into(), "{}".into());
        assert_eq!(store.load(), Ok(Some(before.clone())));
        let values = store.into_inner().values();
        for boundary in 1..=2 {
            let store = StateStore::new(FakeStorage::from_values(values.clone(), boundary));
            assert!(store.save(&state("retry")).is_err());
            assert_eq!(store.load(), Ok(Some(before.clone())));
        }
    }

    #[test]
    fn an_uncommitted_snapshot_cannot_become_fallback() {
        let store = StateStore::new(FakeStorage::default());
        store.save(&state("first")).unwrap();
        store.save(&state("second")).unwrap();
        let store = StateStore::new(FakeStorage::from_values(store.into_inner().values(), 2));
        assert!(store.save(&state("uncommitted")).is_err());
        store
            .storage
            .values
            .borrow_mut()
            .insert("state_b".into(), "{}".into());
        assert_eq!(store.load(), Ok(None));
    }

    #[test]
    fn commissioning_does_not_retain_an_unauthenticated_fallback() {
        let store = StateStore::new(FakeStorage::default());
        store.save(&PersistentState::empty()).unwrap();
        store.save(&state("configured")).unwrap();
        store
            .storage
            .values
            .borrow_mut()
            .insert("state_b".into(), "{}".into());
        assert_eq!(store.load(), Ok(None));
    }

    #[test]
    fn corrupt_reset_does_not_resurrect_credentials() {
        let store = StateStore::new(FakeStorage::default());
        store.save(&state("configured")).unwrap();
        store.save(&PersistentState::empty()).unwrap();
        store
            .storage
            .values
            .borrow_mut()
            .insert("state_b".into(), "{}".into());
        assert_eq!(store.load(), Ok(None));
    }

    #[test]
    fn whole_snapshot_limit_is_checked_before_any_write() {
        let store = StateStore::new(FakeStorage::default());
        let mut candidate = state("boundary");
        candidate.board_descriptor = Some(String::new());
        let overhead = serde_json::to_string(&candidate).unwrap().len();
        candidate.board_descriptor = Some("x".repeat(MAX_STATE_BYTES - overhead));
        store.save(&candidate).unwrap();
        assert_eq!(store.load(), Ok(Some(candidate.clone())));
        let before = store.storage.values();
        candidate.board_descriptor.as_mut().unwrap().push('x');
        assert_eq!(store.save(&candidate), Err(StateError::OversizedState));
        assert_eq!(store.storage.values(), before);
    }
}
