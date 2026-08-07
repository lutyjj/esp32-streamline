//! Audio settings and profile handlers.

use std::sync::Arc;

use anyhow::Result;

use crate::{
    api,
    config::{AudioSettings, RuntimeConfig},
    mutation::MutationError,
    profiles::AudioProfileCatalog,
};

use super::super::{
    requests::form,
    responses::{json_response, mutation_error, reboot_response},
    writes::{save_audio_profiles, write_configuration_and_profiles},
    ApiState, ContractServer,
};

pub(super) fn register_read(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::AUDIO_PROFILES, move |request| {
        let catalog = state.lock_audio_profiles();
        json_response(request, 200, &*catalog)
    })
}

pub(super) fn register_writes(
    server: &mut ContractServer<'_>,
    state: &Arc<ApiState>,
) -> Result<()> {
    // While streaming, audio params are written straight to the running codec
    // and play detection re-baselines to the new input scale; no reboot is
    // needed. Setup mode has no running codec, so the values wait in the
    // configuration and take effect when the device boots into streaming.
    let state_for_audio = Arc::clone(state);
    server.handler(api::SET_AUDIO, move |mut request| {
        // Ok(true) means the settings were applied live.
        let result = (|| -> Result<bool, MutationError> {
            let form: api::AudioSettingsRequest = form(&mut request)?;
            set_audio(
                &state_for_audio,
                AudioSettings {
                    input_line: form.input_line,
                    input_gain: form.input_gain,
                    adc_attenuation_db: form.adc_attenuation_db,
                },
            )
        })();
        match result {
            Ok(true) => json_response(request, 200, &api::Ack::ok()),
            Ok(false) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })?;

    // Replacing definitions never activates a profile as a side effect.
    let state_for_profile_catalog = Arc::clone(state);
    server.handler(api::SET_AUDIO_PROFILES, move |mut request| {
        let result = (|| -> Result<(), MutationError> {
            let form: api::AudioProfilesSettingsRequest = form(&mut request)?;
            let mut catalog: AudioProfileCatalog =
                serde_json::from_str(&form.catalog).map_err(|error| {
                    MutationError::InvalidInput(format!("invalid audio profile catalog: {error}"))
                })?;
            catalog.active_profile_id = None;
            catalog
                .validate(state_for_profile_catalog.board.as_ref())
                .map_err(|error| {
                    MutationError::InvalidInput(format!("invalid audio profile catalog: {error:?}"))
                })?;
            let previous_active = state_for_profile_catalog
                .lock_audio_profiles()
                .active_profile_id
                .clone();
            catalog.active_profile_id = previous_active
                .filter(|id| catalog.profiles.iter().any(|profile| &profile.id == id));
            let current_audio = state_for_profile_catalog.lock_config().audio;
            catalog.reconcile_active_audio(current_audio);
            save_audio_profiles(&state_for_profile_catalog, catalog)
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => mutation_error(request, error),
        }
    })?;

    // A stable activation contract also serves external source selectors.
    let state_for_active_profile = Arc::clone(state);
    server.handler(api::SET_AUDIO_PROFILE, move |mut request| {
        let result = (|| -> Result<bool, MutationError> {
            let form: api::ActiveAudioProfileRequest = form(&mut request)?;
            let mut catalog = state_for_active_profile.lock_audio_profiles().clone();
            let audio = catalog.activate(Some(&form.profile_id)).map_err(|error| {
                MutationError::InvalidInput(format!("invalid active audio profile: {error:?}"))
            })?;
            if let Some(audio) = audio {
                let current = state_for_active_profile.lock_config().clone();
                write_configuration_and_profiles(
                    &state_for_active_profile,
                    RuntimeConfig { audio, ..current },
                    catalog,
                )?;
                return apply_audio_live(&state_for_active_profile, audio);
            }
            save_audio_profiles(&state_for_active_profile, catalog)?;
            Ok(true)
        })();
        match result {
            Ok(true) => json_response(request, 200, &api::Ack::ok()),
            Ok(false) => reboot_response(request),
            Err(error) => mutation_error(request, error),
        }
    })
}

/// Validate, write, and apply new audio settings, returning to custom settings
/// (no active profile). `Ok(true)` means they were applied live; `Ok(false)`
/// means the codec is down and a reboot applies them. Shared by the HTTP
/// handler above and the `cycle_input` button action.
pub(in crate::adapters) fn set_audio(
    state: &ApiState,
    audio: AudioSettings,
) -> Result<bool, MutationError> {
    let current = state.lock_config().clone();
    let audio = audio.validate(state.board.as_ref()).map_err(|error| {
        MutationError::InvalidInput(format!("invalid audio settings: {error:?}"))
    })?;
    let mut catalog = state.lock_audio_profiles().clone();
    catalog.active_profile_id = None;
    write_configuration_and_profiles(state, RuntimeConfig { audio, ..current }, catalog)?;
    apply_audio_live(state, audio)
}

/// Apply already-written settings to the codec and reset play detection.
fn apply_audio_live(state: &ApiState, audio: AudioSettings) -> Result<bool, MutationError> {
    let Some(codec) = &state.codec else {
        return Ok(false);
    };
    let result = codec.lock().expect("codec lock poisoned").apply(audio);
    if let Err(error) = result {
        let mut passthrough = state
            .analog_passthrough
            .lock()
            .expect("analog passthrough lock poisoned");
        if passthrough.active {
            passthrough.record_fault(format!("audio control failed: {error:#}"));
        }
        return Err(MutationError::Internal(format!(
            "could not apply audio settings: {error:#}"
        )));
    }
    if let Some(stream) = &state.stream {
        stream.request_relearn();
    }
    Ok(true)
}
