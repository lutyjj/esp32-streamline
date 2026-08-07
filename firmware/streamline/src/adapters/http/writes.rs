//! Where a configuration write lands: a durable generation, or memory until
//! commissioning.
//!
//! One owner decides, so every settings endpoint behaves the same on an
//! unprovisioned device. See [`crate::mode::ConfigWrite`] for the policy and
//! [`crate::mode::Mode::require_commissioned`] for the operations that opt out
//! of staging.

use crate::{
    config::{ConfigError, RuntimeConfig},
    mode::ConfigWrite,
    mutation::MutationError,
    profiles::{AudioProfileCatalog, AudioProfileError},
    recovery,
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
                .map_err(invalid_configuration)?;
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
    config
        .validate(state.board.as_ref())
        .map_err(invalid_configuration)?;
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

/// The profile catalog is its own durable record, bound to the board rather
/// than to commissioning, so it persists in every mode.
pub(super) fn save_audio_profiles(
    state: &ApiState,
    catalog: AudioProfileCatalog,
) -> Result<(), MutationError> {
    catalog
        .validate(state.board.as_ref())
        .map_err(invalid_catalog)?;
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
    catalog.validate(board).map_err(invalid_catalog)?;
    match state.mode.config_write() {
        ConfigWrite::Persist => {
            config.validate(board).map_err(invalid_configuration)?;
            state
                .lock_store()
                .save_configuration_and_profiles(&config, &catalog, board)
                .map_err(persistence)?;
        }
        ConfigWrite::Stage => {
            config
                .validate_staged(board)
                .map_err(invalid_configuration)?;
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

fn invalid_configuration(error: ConfigError) -> MutationError {
    MutationError::InvalidInput(format!("invalid configuration: {error:?}"))
}

fn invalid_catalog(error: AudioProfileError) -> MutationError {
    MutationError::InvalidInput(format!("invalid audio profile catalog: {error:?}"))
}

fn persistence(error: anyhow::Error) -> MutationError {
    MutationError::Persistence(format!("{error:#}"))
}
