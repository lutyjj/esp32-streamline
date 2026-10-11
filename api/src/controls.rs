//! Shared device control values.

use serde::{Deserialize, Serialize};

/// The behavior assigned to a single board LED.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum LedRole {
    /// Dark: the wire is held at its inactive level.
    #[default]
    Off,
    /// Steadily lit.
    On,
    /// Renders the device status pattern (setup, ready, streaming, fault).
    Status,
}

impl LedRole {
    /// Stable API and storage name for this role.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::On => "on",
            Self::Status => "status",
        }
    }

    /// Decode a role name from the API or storage.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "on" => Some(Self::On),
            "status" => Some(Self::Status),
            _ => None,
        }
    }
}

/// The action assigned to a single board button, fired on a simple press.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum ButtonAction {
    /// The press does nothing.
    #[default]
    None,
    /// Pause or resume streaming to the bridge; capture and meters continue.
    ToggleStream,
    /// Select the next advertised input line, wrapping at the end.
    CycleInput,
    /// Raise the input gain one step, up to the board's advertised maximum.
    GainUp,
    /// Lower the input gain one step, down to zero.
    GainDown,
    /// Attenuate the input one step more (quieter), up to the
    /// board's advertised maximum.
    AttenuationUp,
    /// Attenuate the input one step less (louder), down to zero.
    AttenuationDown,
    /// Reboot with settings intact.
    Restart,
    /// Erase every setting and reboot into first-time setup.
    FactoryReset,
}

impl ButtonAction {
    /// Stable API and storage name for this action.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ToggleStream => "toggle_stream",
            Self::CycleInput => "cycle_input",
            Self::GainUp => "gain_up",
            Self::GainDown => "gain_down",
            Self::AttenuationUp => "attenuation_up",
            Self::AttenuationDown => "attenuation_down",
            Self::Restart => "restart",
            Self::FactoryReset => "factory_reset",
        }
    }

    /// Decode an action name from the API or storage.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "toggle_stream" => Some(Self::ToggleStream),
            "cycle_input" => Some(Self::CycleInput),
            "gain_up" => Some(Self::GainUp),
            "gain_down" => Some(Self::GainDown),
            "attenuation_up" => Some(Self::AttenuationUp),
            "attenuation_down" => Some(Self::AttenuationDown),
            "restart" => Some(Self::Restart),
            "factory_reset" => Some(Self::FactoryReset),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub enum FirmwareVariant {
    Standard,
    Qemu,
    TestSource,
}
