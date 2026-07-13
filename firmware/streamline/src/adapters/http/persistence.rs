//! Failure-atomic configuration persistence for HTTP writes.

use anyhow::{anyhow, Result};

use crate::{config::RuntimeConfig, profiles::AudioProfileCatalog, recovery};

use super::ApiState;

pub(super) fn save_configuration(state: &ApiState, config: RuntimeConfig) -> Result<()> {
    config
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
    let mut committed = state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .clone();
    recovery::commit_after_persist(&mut committed, config, |next| {
        state
            .store
            .lock()
            .map_err(|_| anyhow!("configuration lock poisoned"))?
            .save(next, state.board.as_ref())
    })?;
    *state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))? = committed;
    Ok(())
}

pub(super) fn save_audio_profiles(state: &ApiState, catalog: AudioProfileCatalog) -> Result<()> {
    catalog
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
    state
        .store
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .save_audio_profiles(&catalog, state.board.as_ref())?;
    *state
        .audio_profiles
        .lock()
        .map_err(|_| anyhow!("audio profile lock poisoned"))? = catalog;
    Ok(())
}

/// Persist a cross-record profile activation before exposing either its audio
/// values or its active profile id in memory.
pub(super) fn save_configuration_and_profiles(
    state: &ApiState,
    config: RuntimeConfig,
    catalog: AudioProfileCatalog,
) -> Result<()> {
    config
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid configuration: {error:?}"))?;
    catalog
        .validate(state.board.as_ref())
        .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
    state
        .store
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))?
        .save_configuration_and_profiles(&config, &catalog, state.board.as_ref())?;
    *state
        .config
        .lock()
        .map_err(|_| anyhow!("configuration lock poisoned"))? = config;
    *state
        .audio_profiles
        .lock()
        .map_err(|_| anyhow!("audio profile lock poisoned"))? = catalog;
    Ok(())
}
