//! Failure-atomic configuration persistence for HTTP writes.

use std::sync::MutexGuard;

use crate::{
    adapters::nvs::ConfigStore, config::RuntimeConfig, mutation::MutationError,
    profiles::AudioProfileCatalog, recovery,
};

use super::ApiState;

pub(super) fn save_configuration(
    state: &ApiState,
    config: RuntimeConfig,
) -> Result<(), MutationError> {
    config.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid configuration: {error:?}"))
    })?;
    let mut committed = lock_config(state)?.clone();
    recovery::commit_after_persist(&mut committed, config, |next| {
        lock_store(state)?
            .save(next, state.board.as_ref())
            .map_err(persistence)
    })?;
    *lock_config(state)? = committed;
    Ok(())
}

pub(super) fn save_audio_profiles(
    state: &ApiState,
    catalog: AudioProfileCatalog,
) -> Result<(), MutationError> {
    catalog.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid audio profile catalog: {error:?}"))
    })?;
    lock_store(state)?
        .save_audio_profiles(&catalog, state.board.as_ref())
        .map_err(persistence)?;
    *lock_audio_profiles(state)? = catalog;
    Ok(())
}

/// Persist a cross-record profile activation before exposing either its audio
/// values or its active profile id in memory.
pub(super) fn save_configuration_and_profiles(
    state: &ApiState,
    config: RuntimeConfig,
    catalog: AudioProfileCatalog,
) -> Result<(), MutationError> {
    config.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid configuration: {error:?}"))
    })?;
    catalog.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid audio profile catalog: {error:?}"))
    })?;
    lock_store(state)?
        .save_configuration_and_profiles(&config, &catalog, state.board.as_ref())
        .map_err(persistence)?;
    *lock_config(state)? = config;
    *lock_audio_profiles(state)? = catalog;
    Ok(())
}

pub(super) fn lock_config(
    state: &ApiState,
) -> Result<MutexGuard<'_, RuntimeConfig>, MutationError> {
    state
        .config
        .lock()
        .map_err(|_| MutationError::Internal("configuration lock poisoned".to_owned()))
}

pub(super) fn lock_store(state: &ApiState) -> Result<MutexGuard<'_, ConfigStore>, MutationError> {
    state
        .store
        .lock()
        .map_err(|_| MutationError::Internal("configuration store lock poisoned".to_owned()))
}

pub(super) fn lock_audio_profiles(
    state: &ApiState,
) -> Result<MutexGuard<'_, AudioProfileCatalog>, MutationError> {
    state
        .audio_profiles
        .lock()
        .map_err(|_| MutationError::Internal("audio profile lock poisoned".to_owned()))
}

fn persistence(error: anyhow::Error) -> MutationError {
    MutationError::Persistence(format!("{error:#}"))
}
