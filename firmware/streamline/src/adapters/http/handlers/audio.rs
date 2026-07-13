//! Audio settings and profile handlers.

use std::sync::Arc;

use anyhow::{anyhow, Result};

use crate::{
    api,
    config::{AudioSettings, RuntimeConfig},
    profiles::AudioProfileCatalog,
};

use super::super::{
    auth::authorized_for,
    persistence::{save_audio_profiles, save_configuration_and_profiles},
    requests::form,
    responses::{bad_request, json_response, reboot_response, respond, serialize, unauthorized},
    ApiState, ContractServer,
};

pub(super) fn register_read(server: &mut ContractServer<'_>, state: &Arc<ApiState>) -> Result<()> {
    let state = Arc::clone(state);
    server.handler(api::AUDIO_PROFILES, move |request| {
        respond(
            request,
            200,
            "application/json",
            &audio_profiles_json(&state),
        )
    })
}

pub(super) fn register_writes(
    server: &mut ContractServer<'_>,
    state: &Arc<ApiState>,
) -> Result<()> {
    // While streaming, audio params are written straight to the running codec
    // and play detection re-baselines to the new input scale; no reboot is
    // needed. In setup-AP mode the codec is not running, so the settings are
    // persisted and take effect when the device boots into streaming.
    let state_for_audio = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_AUDIO, move |mut request| {
        if !authorized_for(&request, &state_for_audio, api::SET_AUDIO) {
            return unauthorized(request);
        }
        // Ok(true) means the settings were applied live.
        let result = (|| -> Result<bool> {
            let form: api::AudioSettingsRequest = form(&mut request)?;
            let current = state_for_audio
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .clone();
            let audio = AudioSettings {
                input_line: form.input_line,
                input_gain: form.input_gain,
                adc_attenuation_db: form.adc_attenuation_db,
            }
            .validate(state_for_audio.board.as_ref())
            .map_err(|error| anyhow!("invalid audio settings: {error:?}"))?;
            let mut catalog = state_for_audio
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))?
                .clone();
            catalog.active_profile_id = None;
            save_configuration_and_profiles(
                &state_for_audio,
                RuntimeConfig { audio, ..current },
                catalog,
            )?;
            apply_audio_live(&state_for_audio, audio)
        })();
        match result {
            Ok(true) => json_response(request, 200, &api::Ack::ok()),
            Ok(false) => reboot_response(request),
            Err(error) => bad_request(request, error),
        }
    })?;

    // Replacing definitions never activates a profile as a side effect.
    let state_for_profile_catalog = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_AUDIO_PROFILES, move |mut request| {
        if !authorized_for(
            &request,
            &state_for_profile_catalog,
            api::SET_AUDIO_PROFILES,
        ) {
            return unauthorized(request);
        }
        let result = (|| -> Result<()> {
            let form: api::AudioProfilesSettingsRequest = form(&mut request)?;
            let mut catalog: AudioProfileCatalog = serde_json::from_str(&form.catalog)
                .map_err(|error| anyhow!("invalid audio profile catalog: {error}"))?;
            catalog.active_profile_id = None;
            catalog
                .validate(state_for_profile_catalog.board.as_ref())
                .map_err(|error| anyhow!("invalid audio profile catalog: {error:?}"))?;
            let previous_active = state_for_profile_catalog
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))?
                .active_profile_id
                .clone();
            catalog.active_profile_id = previous_active
                .filter(|id| catalog.profiles.iter().any(|profile| &profile.id == id));
            let current_audio = state_for_profile_catalog
                .config
                .lock()
                .map_err(|_| anyhow!("configuration lock poisoned"))?
                .audio;
            catalog.reconcile_active_audio(current_audio);
            save_audio_profiles(&state_for_profile_catalog, catalog)
        })();
        match result {
            Ok(()) => json_response(request, 200, &api::Ack::ok()),
            Err(error) => bad_request(request, error),
        }
    })?;

    // A stable activation contract also serves external source selectors.
    let state_for_active_profile = Arc::clone(state);
    server.handler::<anyhow::Error, _>(api::SET_AUDIO_PROFILE, move |mut request| {
        if !authorized_for(&request, &state_for_active_profile, api::SET_AUDIO_PROFILE) {
            return unauthorized(request);
        }
        let result = (|| -> Result<bool> {
            let form: api::ActiveAudioProfileRequest = form(&mut request)?;
            let mut catalog = state_for_active_profile
                .audio_profiles
                .lock()
                .map_err(|_| anyhow!("audio profile lock poisoned"))?
                .clone();
            let audio = catalog
                .activate(Some(&form.profile_id))
                .map_err(|error| anyhow!("invalid active audio profile: {error:?}"))?;
            if let Some(audio) = audio {
                let current = state_for_active_profile
                    .config
                    .lock()
                    .map_err(|_| anyhow!("configuration lock poisoned"))?
                    .clone();
                save_configuration_and_profiles(
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
            Err(error) => bad_request(request, error),
        }
    })
}

/// Apply already-persisted settings to the codec and reset play detection.
fn apply_audio_live(state: &ApiState, audio: AudioSettings) -> Result<bool> {
    let Some(codec) = &state.codec else {
        return Ok(false);
    };
    codec
        .lock()
        .map_err(|_| anyhow!("codec lock poisoned"))?
        .apply(audio)?;
    if let Some(stream) = &state.stream {
        stream.request_relearn();
    }
    Ok(true)
}

fn audio_profiles_json(state: &ApiState) -> String {
    let catalog = state
        .audio_profiles
        .lock()
        .expect("audio profile lock poisoned");
    serialize(&*catalog)
}
