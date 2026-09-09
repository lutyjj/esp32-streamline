//! Codec control ownership after initialization.

use super::{es8388::Es8388, Driver, RegisterBus};
use crate::{
    analog_passthrough::{
        route_for_audio_change, AnalogPassthroughControl, AnalogPassthroughRoute,
    },
    config::AudioSettings,
    mutation::MutationError,
};
use anyhow::{anyhow, Result};

impl Driver {
    fn configure(self, bus: &mut impl RegisterBus, audio: AudioSettings) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::configure(bus, audio),
        }
    }

    fn apply(self, bus: &mut impl RegisterBus, audio: AudioSettings) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::apply(bus, audio),
        }
    }

    fn apply_with_passthrough(
        self,
        bus: &mut impl RegisterBus,
        audio: AudioSettings,
        route: AnalogPassthroughRoute,
    ) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::apply_with_passthrough(bus, audio, route),
        }
    }

    fn enable_passthrough(
        self,
        bus: &mut impl RegisterBus,
        route: AnalogPassthroughRoute,
    ) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::enable_passthrough(bus, route),
        }
    }

    fn disable_passthrough(self, bus: &mut impl RegisterBus) -> Result<()> {
        match self {
            Self::Es8388 => Es8388::disable_passthrough(bus),
        }
    }
}

/// Owns the codec's I2C control bus after boot so input settings can change
/// without rebooting the device.
pub struct CodecControl<B: RegisterBus> {
    bus: B,
    driver: Driver,
    audio: AudioSettings,
    passthrough: Option<AnalogPassthroughRoute>,
}

#[derive(Debug)]
pub struct AudioChangeError {
    pub cause: MutationError,
    pub rollback_error: Option<String>,
}

impl<B: RegisterBus> CodecControl<B> {
    pub fn change_audio(
        &mut self,
        audio: AudioSettings,
        commit: impl FnOnce() -> Result<(), MutationError>,
    ) -> Result<(), AudioChangeError> {
        let previous_audio = self.audio;
        let previous_route = self.passthrough;
        let result = self
            .apply(audio)
            .map_err(|error| {
                MutationError::Internal(format!("could not apply audio settings: {error:#}"))
            })
            .and_then(|()| commit());
        if let Err(cause) = result {
            let rollback = self
                .driver
                .apply(&mut self.bus, previous_audio)
                .and_then(|()| match previous_route {
                    Some(route) => self.enable(route),
                    None => Ok(()),
                });
            self.audio = previous_audio;
            let rollback_error = rollback.err().map(|error| {
                let _ = self.disable();
                format!("audio rollback failed: {error:#}; streaming is paused; retry settings or restart")
            });
            return Err(AudioChangeError {
                cause,
                rollback_error,
            });
        }
        Ok(())
    }

    pub fn passthrough_active(&self) -> bool {
        self.passthrough.is_some()
    }

    pub fn new(mut bus: B, driver: Driver, audio: AudioSettings) -> Result<Self> {
        if let Err(error) = driver.configure(&mut bus, audio) {
            let _ = driver.disable_passthrough(&mut bus);
            return Err(error);
        }
        Ok(Self {
            bus,
            driver,
            audio,
            passthrough: None,
        })
    }

    /// Apply new input settings to the running codec.
    fn apply(&mut self, audio: AudioSettings) -> Result<()> {
        let route = self.passthrough.and_then(|current| {
            route_for_audio_change(true, self.audio, audio, current.output_line)
        });
        let result = match route {
            Some(route) => self
                .driver
                .apply_with_passthrough(&mut self.bus, audio, route),
            None => self.driver.apply(&mut self.bus, audio),
        };
        if let Err(error) = result {
            if self.passthrough.is_some() {
                let close = self.driver.disable_passthrough(&mut self.bus);
                self.passthrough = None;
                if let Err(close_error) = close {
                    return Err(anyhow!("{error:#}; fail-close failed: {close_error:#}"));
                }
            }
            return Err(error);
        }
        self.audio = audio;
        if let Some(route) = route {
            self.passthrough = Some(route);
        }
        Ok(())
    }
}

impl<B: RegisterBus> AnalogPassthroughControl for CodecControl<B> {
    type Error = anyhow::Error;

    fn enable(&mut self, route: AnalogPassthroughRoute) -> Result<()> {
        self.driver.enable_passthrough(&mut self.bus, route)?;
        self.passthrough = Some(route);
        Ok(())
    }

    fn disable(&mut self) -> Result<()> {
        let result = self.driver.disable_passthrough(&mut self.bus);
        self.passthrough = None;
        result
    }
}
