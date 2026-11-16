//! How the last firmware install ended, read across the restart it causes.
//!
//! An install leaves a record in storage before it writes the inactive slot
//! and when it ends. Each boot compares that record with the slot it runs
//! from, so status reports the outcome and no client infers it from versions.

use serde::Serialize;

/// What the last install left in storage, naming slots by partition label.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InstallRecord {
    /// The install began writing the slot and has not ended.
    Started(String),
    /// The install stopped before it selected the slot.
    Failed,
    /// The install wrote and selected the slot.
    Written(String),
}

/// How the last install ended, as `/api/status` reports it.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "api-spec", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum InstallResult {
    /// No install has written a slot since the last factory reset.
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

const STARTED: &str = "started:";
const FAILED: &str = "failed";
const WRITTEN: &str = "written:";

impl InstallRecord {
    /// The record as storage keeps it.
    pub fn encode(&self) -> String {
        match self {
            Self::Started(slot) => format!("{STARTED}{slot}"),
            Self::Failed => FAILED.to_owned(),
            Self::Written(slot) => format!("{WRITTEN}{slot}"),
        }
    }

    /// Read a stored record; `None` for an empty or unknown value.
    pub fn decode(stored: &str) -> Option<Self> {
        if stored == FAILED {
            return Some(Self::Failed);
        }
        let slot = |prefix: &str| {
            stored
                .strip_prefix(prefix)
                .filter(|slot| !slot.is_empty())
                .map(str::to_owned)
        };
        slot(STARTED)
            .map(Self::Started)
            .or_else(|| slot(WRITTEN).map(Self::Written))
    }

    /// How the install ended, seen from a boot that runs from `running_slot`.
    /// A boot that finds an install only started was restarted during it,
    /// unless it runs the new slot: the install selected the slot and lost
    /// power before it recorded so.
    pub fn result(&self, running_slot: &str) -> InstallResult {
        match self {
            Self::Started(slot) if slot == running_slot => InstallResult::Installed,
            Self::Started(_) | Self::Failed => InstallResult::Failed,
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
            InstallRecord::Started("ota_1".to_owned()),
            InstallRecord::Failed,
            InstallRecord::Written("ota_1".to_owned()),
        ] {
            assert_eq!(InstallRecord::decode(&record.encode()), Some(record));
        }
        for unknown in ["", "started:", "written:", "installed", "v0.1.0: installed"] {
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
        let started = InstallRecord::Started("ota_1".to_owned());
        assert_eq!(started.result("ota_0"), InstallResult::Failed);
        assert_eq!(InstallRecord::Failed.result("ota_0"), InstallResult::Failed);
    }

    #[test]
    fn a_selected_slot_whose_record_was_lost_counts_as_installed() {
        let started = InstallRecord::Started("ota_1".to_owned());
        assert_eq!(started.result("ota_1"), InstallResult::Installed);
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
