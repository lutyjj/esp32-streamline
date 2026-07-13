//! Versioned PCM transport policy and failure-safe per-device key lifecycle.

use core::fmt;

use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: u8 = 1;
pub const DEFAULT_SECURE_PORT: u16 = 39_001;
pub const PSK_BYTES: usize = 32;
pub const KEY_ID_RANDOM_BYTES: usize = 16;
pub const KEY_ID_PREFIX: &str = "eli1-";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum TransportMode {
    #[default]
    Cleartext,
    TlsPsk,
}

impl TransportMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Cleartext => "cleartext",
            Self::TlsPsk => "tls-psk",
        }
    }
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct TransportPsk([u8; PSK_BYTES]);

impl TransportPsk {
    pub const fn new(bytes: [u8; PSK_BYTES]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; PSK_BYTES] {
        &self.0
    }

    pub fn hex(&self) -> String {
        encode_hex(&self.0)
    }
}

impl fmt::Debug for TransportPsk {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted transport PSK>")
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TransportKey {
    id: String,
    psk: TransportPsk,
}

impl TransportKey {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub const fn psk(&self) -> &TransportPsk {
        &self.psk
    }

    pub fn identity(&self) -> String {
        format!("eli1:{CONTRACT_VERSION}:{}", self.id)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum KeySlot {
    A,
    B,
}

impl KeySlot {
    const fn other(self) -> Self {
        match self {
            Self::A => Self::B,
            Self::B => Self::A,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct TransportKeys {
    slot_a: Option<TransportKey>,
    slot_b: Option<TransportKey>,
    active: Option<KeySlot>,
    pending: Option<KeySlot>,
    pending_verified: bool,
}

impl TransportKeys {
    pub fn active(&self) -> Option<&TransportKey> {
        self.active.and_then(|slot| self.get(slot))
    }

    pub fn pending(&self) -> Option<&TransportKey> {
        self.pending.and_then(|slot| self.get(slot))
    }

    pub fn rollback(&self) -> Option<&TransportKey> {
        let active = self.active?;
        if self.pending.is_some() {
            return None;
        }
        self.get(active.other())
    }

    pub const fn pending_verified(&self) -> bool {
        self.pending_verified
    }

    pub fn stage(&mut self, random: &mut impl RandomBytes) -> Result<TransportKey, TransportError> {
        if self.pending.is_some() {
            return Err(TransportError::PendingKeyExists);
        }
        let slot = self.active.map_or(KeySlot::A, KeySlot::other);
        let mut id_random = [0_u8; KEY_ID_RANDOM_BYTES];
        let mut psk = [0_u8; PSK_BYTES];
        random.fill(&mut id_random);
        random.fill(&mut psk);
        let key = TransportKey {
            id: format!("{KEY_ID_PREFIX}{}", encode_hex(&id_random)),
            psk: TransportPsk::new(psk),
        };
        if self.active().is_some_and(|active| active.id() == key.id()) {
            return Err(TransportError::DuplicateKeyId);
        }
        self.set(slot, Some(key.clone()));
        self.pending = Some(slot);
        self.pending_verified = false;
        Ok(key)
    }

    pub fn recover(
        &mut self,
        random: &mut impl RandomBytes,
    ) -> Result<TransportKey, TransportError> {
        if let Some(active) = self.active {
            self.set(active.other(), None);
        } else {
            self.slot_a = None;
            self.slot_b = None;
        }
        self.pending = None;
        self.pending_verified = false;
        self.stage(random)
    }

    pub fn mark_pending_verified(&mut self) -> Result<(), TransportError> {
        if self.pending().is_none() {
            return Err(TransportError::NoPendingKey);
        }
        self.pending_verified = true;
        Ok(())
    }

    pub fn activate(&mut self) -> Result<(), TransportError> {
        let pending = self.pending.ok_or(TransportError::NoPendingKey)?;
        if !self.pending_verified {
            return Err(TransportError::PendingKeyUnverified);
        }
        self.active = Some(pending);
        self.pending = None;
        self.pending_verified = false;
        Ok(())
    }

    pub fn rollback_key(&mut self) -> Result<(), TransportError> {
        if self.pending.is_some() {
            return Err(TransportError::PendingKeyExists);
        }
        let active = self.active.ok_or(TransportError::NoActiveKey)?;
        let rollback = active.other();
        if self.get(rollback).is_none() {
            return Err(TransportError::NoRollbackKey);
        }
        self.active = Some(rollback);
        Ok(())
    }

    pub fn retire_rollback(&mut self) -> Result<(), TransportError> {
        if self.pending.is_some() {
            return Err(TransportError::PendingKeyExists);
        }
        let active = self.active.ok_or(TransportError::NoActiveKey)?;
        let rollback = active.other();
        if self.get(rollback).is_none() {
            return Err(TransportError::NoRollbackKey);
        }
        self.set(rollback, None);
        Ok(())
    }

    pub fn validate(&self) -> Result<(), TransportError> {
        if self.active.is_some_and(|slot| self.get(slot).is_none()) {
            return Err(TransportError::InvalidKeyState);
        }
        if self.pending.is_some_and(|slot| {
            self.get(slot).is_none() || self.active.is_some_and(|active| active == slot)
        }) {
            return Err(TransportError::InvalidKeyState);
        }
        if self.pending_verified && self.pending.is_none() {
            return Err(TransportError::InvalidKeyState);
        }
        for key in [self.slot_a.as_ref(), self.slot_b.as_ref()]
            .into_iter()
            .flatten()
        {
            if !valid_key_id(key.id()) {
                return Err(TransportError::InvalidKeyId);
            }
        }
        if self
            .slot_a
            .as_ref()
            .zip(self.slot_b.as_ref())
            .is_some_and(|(a, b)| a.id() == b.id())
        {
            return Err(TransportError::DuplicateKeyId);
        }
        Ok(())
    }

    fn get(&self, slot: KeySlot) -> Option<&TransportKey> {
        match slot {
            KeySlot::A => self.slot_a.as_ref(),
            KeySlot::B => self.slot_b.as_ref(),
        }
    }

    fn set(&mut self, slot: KeySlot, value: Option<TransportKey>) {
        match slot {
            KeySlot::A => self.slot_a = value,
            KeySlot::B => self.slot_b = value,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct TransportSettings {
    pub contract_version: u8,
    pub mode: TransportMode,
    pub secure_port: u16,
    pub keys: TransportKeys,
}

impl Default for TransportSettings {
    fn default() -> Self {
        Self {
            contract_version: CONTRACT_VERSION,
            mode: TransportMode::Cleartext,
            secure_port: DEFAULT_SECURE_PORT,
            keys: TransportKeys::default(),
        }
    }
}

impl TransportSettings {
    pub fn validate(&self) -> Result<(), TransportError> {
        if self.contract_version != CONTRACT_VERSION {
            return Err(TransportError::UnsupportedVersion);
        }
        if self.secure_port == 0 {
            return Err(TransportError::InvalidSecurePort);
        }
        self.keys.validate()?;
        if self.mode == TransportMode::TlsPsk && self.keys.active().is_none() {
            return Err(TransportError::NoActiveKey);
        }
        Ok(())
    }

    pub const fn effective_port(&self, cleartext_port: u16) -> u16 {
        match self.mode {
            TransportMode::Cleartext => cleartext_port,
            TransportMode::TlsPsk => self.secure_port,
        }
    }
}

pub trait RandomBytes {
    fn fill(&mut self, output: &mut [u8]);
}

/// Hardware/network edge used only to prove a staged key before activation.
pub trait KeyVerifier: Send + Sync {
    fn verify(&self, host: &str, port: u16, key: &TransportKey) -> Result<(), String>;
}

pub fn verify_pending(
    settings: &mut TransportSettings,
    host: &str,
    verifier: &dyn KeyVerifier,
) -> Result<(), VerifyPendingError> {
    if host.is_empty() {
        return Err(VerifyPendingError::MissingTarget);
    }
    let key = settings
        .keys
        .pending()
        .ok_or(VerifyPendingError::NoPendingKey)?;
    verifier
        .verify(host, settings.secure_port, key)
        .map_err(VerifyPendingError::Rejected)?;
    settings
        .keys
        .mark_pending_verified()
        .map_err(|_| VerifyPendingError::NoPendingKey)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VerifyPendingError {
    MissingTarget,
    NoPendingKey,
    Rejected(String),
}

impl fmt::Display for VerifyPendingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTarget => {
                formatter.write_str("configure a bridge target before verifying a key")
            }
            Self::NoPendingKey => formatter.write_str("no pending PCM transport key exists"),
            Self::Rejected(reason) => write!(
                formatter,
                "bridge rejected the pending PCM transport key: {reason}"
            ),
        }
    }
}

impl std::error::Error for VerifyPendingError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportError {
    UnsupportedVersion,
    InvalidSecurePort,
    InvalidKeyState,
    InvalidKeyId,
    DuplicateKeyId,
    PendingKeyExists,
    NoPendingKey,
    PendingKeyUnverified,
    NoActiveKey,
    NoRollbackKey,
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::UnsupportedVersion => "unsupported PCM transport contract version",
            Self::InvalidSecurePort => "secure PCM port must be non-zero",
            Self::InvalidKeyState => "invalid PCM transport key state",
            Self::InvalidKeyId => "invalid PCM transport key id",
            Self::DuplicateKeyId => "PCM transport key ids must be unique",
            Self::PendingKeyExists => "a pending PCM transport key already exists",
            Self::NoPendingKey => "no pending PCM transport key exists",
            Self::PendingKeyUnverified => "pending PCM transport key has not been verified",
            Self::NoActiveKey => "no active PCM transport key exists",
            Self::NoRollbackKey => "no PCM transport rollback key exists",
        })
    }
}

impl std::error::Error for TransportError {}

fn valid_key_id(value: &str) -> bool {
    value.len() == KEY_ID_PREFIX.len() + KEY_ID_RANDOM_BYTES * 2
        && value.starts_with(KEY_ID_PREFIX)
        && value[KEY_ID_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[usize::from(byte >> 4)] as char);
        encoded.push(HEX[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sequence(u8);

    impl RandomBytes for Sequence {
        fn fill(&mut self, output: &mut [u8]) {
            for byte in output {
                *byte = self.0;
                self.0 = self.0.wrapping_add(1);
            }
        }
    }

    struct Verifier(Result<(), &'static str>);

    impl KeyVerifier for Verifier {
        fn verify(&self, _host: &str, _port: u16, _key: &TransportKey) -> Result<(), String> {
            self.0.map_err(str::to_owned)
        }
    }

    #[test]
    fn secure_mode_requires_an_active_key() {
        let settings = TransportSettings {
            mode: TransportMode::TlsPsk,
            ..TransportSettings::default()
        };
        assert_eq!(settings.validate(), Err(TransportError::NoActiveKey));
    }

    #[test]
    fn stage_verify_activate_rotate_rollback_and_retire() {
        let mut keys = TransportKeys::default();
        let first = keys.stage(&mut Sequence(0)).expect("first key");
        assert_eq!(first.id(), "eli1-000102030405060708090a0b0c0d0e0f");
        assert_eq!(first.psk().as_bytes()[0], 16);
        assert_eq!(keys.activate(), Err(TransportError::PendingKeyUnverified));
        keys.mark_pending_verified().expect("verified");
        keys.activate().expect("activated");
        assert_eq!(keys.active().map(TransportKey::id), Some(first.id()));

        let second = keys.stage(&mut Sequence(64)).expect("rotation key");
        assert_eq!(keys.rollback(), None);
        keys.mark_pending_verified().expect("verified");
        keys.activate().expect("rotated");
        assert_eq!(keys.active().map(TransportKey::id), Some(second.id()));
        assert_eq!(keys.rollback().map(TransportKey::id), Some(first.id()));

        keys.rollback_key().expect("rolled back");
        assert_eq!(keys.active().map(TransportKey::id), Some(first.id()));
        assert_eq!(keys.rollback().map(TransportKey::id), Some(second.id()));
        keys.retire_rollback().expect("retired");
        assert_eq!(keys.rollback(), None);
        assert_eq!(keys.validate(), Ok(()));
    }

    #[test]
    fn recovery_replaces_pending_and_keeps_the_active_key_for_rollback() {
        let mut keys = TransportKeys::default();
        keys.stage(&mut Sequence(0)).expect("first");
        keys.mark_pending_verified().expect("verified");
        keys.activate().expect("active");
        let abandoned = keys.stage(&mut Sequence(64)).expect("pending");

        let recovered = keys.recover(&mut Sequence(128)).expect("recovered");

        assert_ne!(recovered.id(), abandoned.id());
        assert_eq!(keys.pending().map(TransportKey::id), Some(recovered.id()));
        assert!(!keys.pending_verified());
        assert!(keys.active().is_some());
    }

    #[test]
    fn persisted_psks_are_not_exposed_by_debug_output() {
        let mut keys = TransportKeys::default();
        let key = keys.stage(&mut Sequence(0)).expect("key");
        let debug = format!("{keys:?}");
        assert!(!debug.contains(&key.psk().hex()));
        assert!(debug.contains("redacted"));
    }

    #[test]
    fn pending_verification_changes_state_only_after_the_probe_succeeds() {
        let mut settings = TransportSettings::default();
        settings.keys.stage(&mut Sequence(0)).expect("key");

        let rejected = verify_pending(&mut settings, "bridge.local", &Verifier(Err("wrong key")));
        assert_eq!(
            rejected,
            Err(VerifyPendingError::Rejected("wrong key".to_owned()))
        );
        assert!(!settings.keys.pending_verified());

        verify_pending(&mut settings, "bridge.local", &Verifier(Ok(()))).expect("accepted");
        assert!(settings.keys.pending_verified());
    }
}
