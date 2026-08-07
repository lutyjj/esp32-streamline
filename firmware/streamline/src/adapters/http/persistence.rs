//! Failure-atomic configuration persistence for HTTP writes.

use crate::{
    config::RuntimeConfig, mutation::MutationError, profiles::AudioProfileCatalog, recovery,
};

use super::ApiState;

pub(super) fn save_configuration(
    state: &ApiState,
    config: RuntimeConfig,
) -> Result<(), MutationError> {
    config.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid configuration: {error:?}"))
    })?;
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

pub(super) fn save_audio_profiles(
    state: &ApiState,
    catalog: AudioProfileCatalog,
) -> Result<(), MutationError> {
    catalog.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid audio profile catalog: {error:?}"))
    })?;
    state
        .lock_store()
        .save_audio_profiles(&catalog, state.board.as_ref())
        .map_err(persistence)?;
    *state.lock_audio_profiles() = catalog;
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
    state
        .lock_store()
        .save_configuration_and_profiles(&config, &catalog, state.board.as_ref())
        .map_err(persistence)?;
    *state.lock_config() = config;
    *state.lock_audio_profiles() = catalog;
    Ok(())
}

fn persistence(error: anyhow::Error) -> MutationError {
    MutationError::Persistence(format!("{error:#}"))
}
