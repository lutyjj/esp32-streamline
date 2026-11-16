//! How the last firmware install ended, read across the restart it causes.
//!
//! An install leaves a record in storage before it downloads and when it
//! ends. Each boot compares that record with the slot it runs from, so status
//! reports the outcome and no client infers it from versions.

use serde::Serialize;

/// What the last install left in storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallRecord {
    /// The install began; a boot that still finds this cut it short.
    Started,
    /// The install stopped before the device restarted into a new image.
    Failed,
    /// The install wrote and selected the slot with this partition label.
    Written(String),
}

/// How the last install ended, as `/api/status` reports it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum InstallResult {
    /// No install has run since the last factory reset.
    #[default]
    None,
    /// The install stopped before the device restarted into the new image:
    /// the download or the image was refused, or the device restarted during
    /// the install.
    Failed,
    /// The device runs the image the last install wrote.
    Installed,
    /// The device runs the other slot: the new image did not start, or a
    /// rollback returned to the one before it.
    RolledBack,
}

const STARTED: &str = "started";
const FAILED: &str = "failed";
const WRITTEN: &str = "written:";

impl InstallRecord {
    /// The record as storage keeps it.
    pub fn encode(&self) -> String {
        match self {
            Self::Started => STARTED.to_owned(),
            Self::Failed => FAILED.to_owned(),
            Self::Written(slot) => format!("{WRITTEN}{slot}"),
        }
    }

    /// Read a stored record; `None` for an empty or unknown value.
    pub fn decode(stored: &str) -> Option<Self> {
        match stored {
            STARTED => Some(Self::Started),
            FAILED => Some(Self::Failed),
            _ => stored
                .strip_prefix(WRITTEN)
                .filter(|slot| !slot.is_empty())
                .map(|slot| Self::Written(slot.to_owned())),
        }
    }

    /// How the install ended, seen from a boot that runs from `running_slot`.
    /// A boot that finds the install only started sees it cut short.
    pub fn result(&self, running_slot: &str) -> InstallResult {
        match self {
            Self::Started | Self::Failed => InstallResult::Failed,
            Self::Written(slot) if slot == running_slot => InstallResult::Installed,
            Self::Written(_) => InstallResult::RolledBack,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_survive_storage() {
        for record in [
            InstallRecord::Started,
            InstallRecord::Failed,
            InstallRecord::Written("ota_1".to_owned()),
        ] {
            assert_eq!(InstallRecord::decode(&record.encode()), Some(record));
        }
        for unknown in ["", "written:", "installed", "v0.1.0: installed"] {
            assert_eq!(InstallRecord::decode(unknown), None, "{unknown:?}");
        }
    }

    #[test]
    fn the_running_slot_tells_an_installed_image_from_a_rollback() {
        let written = InstallRecord::Written("ota_1".to_owned());
        assert_eq!(written.result("ota_1"), InstallResult::Installed);
        assert_eq!(written.result("ota_0"), InstallResult::RolledBack);
    }

    #[test]
    fn an_install_cut_short_by_a_restart_failed() {
        assert_eq!(
            InstallRecord::Started.result("ota_0"),
            InstallResult::Failed
        );
        assert_eq!(InstallRecord::Failed.result("ota_0"), InstallResult::Failed);
    }

    #[test]
    fn results_serialize_as_the_contract_names_them() {
        let names = [
            InstallResult::None,
            InstallResult::Failed,
            InstallResult::Installed,
            InstallResult::RolledBack,
        ]
        .map(|result| serde_json::to_string(&result).expect("serializable"));
        assert_eq!(
            names,
            [
                r#""none""#,
                r#""failed""#,
                r#""installed""#,
                r#""rolled-back""#
            ]
        );
    }
}
