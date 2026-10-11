//! Startup health verdict assembled from boot facts.
//!
//! A boot snapshot, not a monitor: the boot flow reports what it observed —
//! did the audio codec answer, is a bridge configured — and this module turns
//! those facts into a verdict the console renders and a script can probe. The
//! hardware calls stay in the adapters; the assembly is pure and host-tested.
//! Adding a check is adding an entry to [`assess`]; consumers and
//! sibling checks do not change.

use streamline_api::health::CheckStatus;
use streamline_api::health::HealthCheck;
use streamline_api::health::HealthReport;
use streamline_api::health::Severity;

/// What the boot flow observed, before the verdict is assembled. The adapters
/// produce these facts; the core turns them into checks.
pub struct BootFacts {
    /// The audio bring-up result: `Ok` when the codec answered and audio
    /// started, `Err(reason)` when it did not. `None` in setup mode, where
    /// audio is not brought up at all.
    pub audio: Option<Result<(), String>>,
    /// A bridge stream target is configured. Meaningful only when provisioned.
    pub bridge_configured: bool,
    /// Display name of the resolved board descriptor, named in the copy.
    pub board_name: String,
}

/// Assemble the verdict from what the boot flow saw.
pub fn assess(facts: &BootFacts) -> HealthReport {
    let mut checks = Vec::new();
    if let Some(audio) = &facts.audio {
        checks.push(codec_check(audio, &facts.board_name));
        checks.push(bridge_check(facts.bridge_configured));
    }
    let status = checks
        .iter()
        .map(|check| check.severity)
        .max_by_key(|severity| severity.rank())
        .unwrap_or(Severity::Ok);
    HealthReport { status, checks }
}

/// Did the audio codec on this board answer? The board descriptor drives which
/// codec, address, and pins were written, so a failure points at the descriptor
/// or the wiring.
fn codec_check(audio: &Result<(), String>, board_name: &str) -> HealthCheck {
    match audio {
        Ok(()) => HealthCheck {
            id: "codec",
            status: CheckStatus::Ok,
            severity: Severity::Ok,
            detail: format!("The {board_name} audio codec answered and is streaming-ready."),
            remedy: None,
            fixable: false,
        },
        Err(reason) => HealthCheck {
            id: "codec",
            status: CheckStatus::Fail,
            severity: Severity::Blocking,
            detail: format!("Audio hardware did not initialize on {board_name}: {reason}."),
            remedy: Some(
                "Confirm the board descriptor matches this hardware and the codec is wired to \
                 its listed I2C pins, then restart the device."
                    .to_owned(),
            ),
            fixable: true,
        },
    }
}

/// Is a bridge target set? Missing one is the normal Stage-3 next step, never a
/// fault — capture still runs, only streaming waits.
fn bridge_check(configured: bool) -> HealthCheck {
    if configured {
        HealthCheck {
            id: "bridge",
            status: CheckStatus::Ok,
            severity: Severity::Ok,
            detail: "A bridge target is set.".to_owned(),
            remedy: None,
            fixable: false,
        }
    } else {
        HealthCheck {
            id: "bridge",
            status: CheckStatus::Warn,
            severity: Severity::Info,
            detail: "No bridge target is set yet, so nothing is streaming.".to_owned(),
            remedy: Some("Set the bridge host and port in the Network tab.".to_owned()),
            fixable: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(audio: Option<Result<(), String>>, bridge_configured: bool) -> BootFacts {
        BootFacts {
            audio,
            bridge_configured,
            board_name: "Test Board".to_owned(),
        }
    }

    #[test]
    fn codec_failure_blocks_and_offers_a_remedy() {
        let report = assess(&facts(Some(Err("codec setup failed".to_owned())), false));
        assert_eq!(report.status, Severity::Blocking);
        let codec = report
            .checks
            .iter()
            .find(|c| c.id == "codec")
            .expect("codec check");
        assert_eq!(codec.status, CheckStatus::Fail);
        assert_eq!(codec.severity, Severity::Blocking);
        assert!(codec.detail.contains("codec setup failed"));
        assert!(codec.remedy.is_some());
        assert!(codec.fixable);
    }

    #[test]
    fn no_bridge_is_info_not_a_fault() {
        let report = assess(&facts(Some(Ok(())), false));
        assert_eq!(report.status, Severity::Info);
        let bridge = report
            .checks
            .iter()
            .find(|c| c.id == "bridge")
            .expect("bridge check");
        assert_eq!(bridge.severity, Severity::Info);
        assert_eq!(bridge.status, CheckStatus::Warn);
    }

    #[test]
    fn healthy_codec_and_bridge_report_ok() {
        let report = assess(&facts(Some(Ok(())), true));
        assert_eq!(report.status, Severity::Ok);
        assert!(report.checks.iter().all(|c| c.severity == Severity::Ok));
    }

    #[test]
    fn overall_is_the_worst_severity() {
        // Codec blocking outweighs an info-level bridge.
        let report = assess(&facts(Some(Err("no ack".to_owned())), false));
        assert_eq!(report.status, Severity::Blocking);
    }

    #[test]
    fn setup_mode_has_nothing_to_check() {
        let report = assess(&facts(None, false));
        assert_eq!(report.status, Severity::Ok);
        assert!(report.checks.is_empty());
        assert_eq!(HealthReport::healthy(), report);
    }

    #[test]
    fn serializes_with_lowercase_severity_and_status() {
        let report = assess(&facts(Some(Err("x".to_owned())), false));
        let json = serde_json::to_string(&report).expect("serializable");
        assert!(json.contains(r#""status":"blocking""#));
        assert!(json.contains(r#""id":"codec""#));
        assert!(json.contains(r#""severity":"blocking""#));
        assert!(json.contains(r#""fixable":true"#));
    }
}
