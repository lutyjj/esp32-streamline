//! Where a configuration write lands: a durable generation, or memory until
//! commissioning.
//!
//! One owner decides, so every settings endpoint behaves the same on an
//! unprovisioned device. See [`crate::mode::ConfigWrite`] for the policy and
//! [`crate::mode::Mode::require_commissioned`] for the operations that opt out
//! of staging.

use crate::{
    config::RuntimeConfig, mode::ConfigWrite, mutation::MutationError,
    profiles::AudioProfileCatalog, recovery,
};

use super::ApiState;

/// Apply one change to a copy of the configuration and expose the result only
/// after the change landed where this mode puts it.
pub(super) fn update_configuration<T>(
    state: &ApiState,
    change: impl FnOnce(&mut RuntimeConfig) -> Result<T, MutationError>,
) -> Result<T, MutationError> {
    let mut next = state.lock_config().clone();
    let value = change(&mut next)?;
    match state.mode.config_write() {
        ConfigWrite::Persist => persist_configuration(state, next)?,
        ConfigWrite::Stage => {
            next.validate_staged(state.board.as_ref())
                .map_err(MutationError::from)?;
            *state.lock_config() = next;
        }
    }
    Ok(value)
}

/// Commit a configuration as a durable generation whatever the mode.
///
/// Commissioning is the one write that must persist from setup mode: it
/// supplies the SSID and admin key that every staged write is waiting for.
pub(super) fn persist_configuration(
    state: &ApiState,
    config: RuntimeConfig,
) -> Result<(), MutationError> {
    validate_configuration(state, &config)?;
    let mut committed = state.lock_config().clone();
    recovery::commit_after_persist(&mut committed, config, |next| {
        state
            .lock_store()
            .save(next, state.board.as_ref())
            .map_err(persistence)
    })?;
    *state.lock_config() = committed;
    Ok(())
}

/// Check a configuration against the board before any side effect.
pub(super) fn validate_configuration(
    state: &ApiState,
    config: &RuntimeConfig,
) -> Result<(), MutationError> {
    config
        .validate(state.board.as_ref())
        .map_err(MutationError::from)
}

/// The profile catalog is its own durable record, bound to the board rather
/// than to commissioning, so it persists in every mode.
pub(super) fn save_audio_profiles(
    state: &ApiState,
    catalog: AudioProfileCatalog,
) -> Result<(), MutationError> {
    // A catalog from a request is checked, and its refusal named, before it
    // gets here; this check guards the stored one, which no request field holds.
    catalog
        .validate(state.board.as_ref())
        .map_err(|error| MutationError::InvalidInput(error.to_string()))?;
    state
        .lock_store()
        .save_audio_profiles(&catalog, state.board.as_ref())
        .map_err(persistence)?;
    *state.lock_audio_profiles() = catalog;
    Ok(())
}

/// Write a cross-record profile activation before exposing either its audio
/// values or its active profile id in memory. A staged configuration has no
/// durable record to share a generation with, so only the catalog commits.
pub(super) fn write_configuration_and_profiles(
    state: &ApiState,
    config: RuntimeConfig,
    catalog: AudioProfileCatalog,
) -> Result<(), MutationError> {
    let board = state.board.as_ref();
    // The catalog here is the stored one, so its refusal names no request field.
    catalog
        .validate(board)
        .map_err(|error| MutationError::InvalidInput(error.to_string()))?;
    match state.mode.config_write() {
        ConfigWrite::Persist => {
            config.validate(board).map_err(MutationError::from)?;
            state
                .lock_store()
                .save_configuration_and_profiles(&config, &catalog, board)
                .map_err(persistence)?;
        }
        ConfigWrite::Stage => {
            config.validate_staged(board).map_err(MutationError::from)?;
            state
                .lock_store()
                .save_audio_profiles(&catalog, board)
                .map_err(persistence)?;
        }
    }
    *state.lock_config() = config;
    *state.lock_audio_profiles() = catalog;
    Ok(())
}

fn persistence(error: anyhow::Error) -> MutationError {
    if matches!(
        error.downcast_ref::<crate::state::StateError<anyhow::Error>>(),
        Some(crate::state::StateError::OversizedState)
    ) {
        return MutationError::InvalidInput(error.to_string());
    }
    MutationError::Persistence(format!("{error:#}"))
}
