//! Health report wire values.

use serde::Serialize;

/// How much a check's outcome matters to the user journey. A report's overall
/// [`HealthReport::status`] is the worst severity across its checks.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Everything the check covers is working.
    Ok,
    /// A normal next step, not a fault — the device is usable as is.
    Info,
    /// The device is not usable until the user acts.
    Blocking,
}

impl Severity {
    pub const fn rank(self) -> u8 {
        match self {
            Severity::Ok => 0,
            Severity::Info => 1,
            Severity::Blocking => 2,
        }
    }
}

/// The outcome of one check, independent of how much it matters.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

/// One thing the startup check looked at.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct HealthCheck {
    /// Stable machine id, e.g. `"codec"`. Scripts and the console key off this.
    pub id: &'static str,
    pub status: CheckStatus,
    pub severity: Severity,
    /// Plain-language description of what the check found.
    pub detail: String,
    /// What the user does about it, when there is something to do.
    pub remedy: Option<String>,
    /// Whether the console offers an action that resolves it.
    pub fixable: bool,
}

/// The startup verdict: every check plus the worst severity across them.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct HealthReport {
    pub status: Severity,
    pub checks: Vec<HealthCheck>,
}

impl HealthReport {
    /// A device with nothing to check yet — setup mode, before it reaches the
    /// home network.
    pub fn healthy() -> Self {
        Self {
            status: Severity::Ok,
            checks: Vec::new(),
        }
    }
}
