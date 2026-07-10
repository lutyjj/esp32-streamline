//! ESP-IDF NVS persistence for StreamLine configuration.

use anyhow::{anyhow, bail, Result};
use esp_idf_svc::nvs::{EspDefaultNvs, EspDefaultNvsPartition, EspNvs};

use crate::{
    board::{self, Board, BoardSelection},
    config::{
        AudioSettings, AutoUpdateSchedule, ConfigError, RuntimeConfig, CONFIG_SCHEMA_VERSION,
    },
};

const NAMESPACE: &str = "streamline";
const KEY_SCHEMA: &str = "schema";
const KEY_SSID: &str = "ssid";
const KEY_PASSWORD: &str = "password";
const KEY_TARGET_HOST: &str = "target_host";
const KEY_TARGET_PORT: &str = "target_port";
const KEY_ADMIN_SECRET: &str = "admin_secret";
const KEY_DEVICE_NAME: &str = "device_name";
const KEY_AUTO_UPDATE: &str = "auto_update";
const KEY_BOARD_ID: &str = "board_id";
const KEY_BOARD_DESCRIPTOR: &str = "board_json";
const KEY_INPUT_LINE: &str = "input_line";
const KEY_INPUT_GAIN: &str = "input_gain";
const KEY_ADC_ATTENUATION: &str = "adc_attenuation";
const KEY_LAST_FALLBACK: &str = "last_fallback";
const KEY_LAST_OTA: &str = "last_ota";
/// Diagnostic notes are trimmed to fit the 256-byte read buffer.
const MAX_NOTE_BYTES: usize = 240;
/// Keep custom descriptors comfortably below ESP-IDF's NVS string limit.
pub const MAX_BOARD_DESCRIPTOR_BYTES: usize = 3_072;
const MAX_BOARD_DESCRIPTOR_BUFFER_BYTES: usize = MAX_BOARD_DESCRIPTOR_BYTES + 1;

/// Owns the NVS namespace and keeps the partition alive for the lifetime of
/// all reads and writes. The namespace is versioned so future migrations have
/// an explicit decision point rather than silently accepting incompatible data.
pub struct ConfigStore {
    nvs: EspDefaultNvs,
}

impl ConfigStore {
    pub fn open(partition: EspDefaultNvsPartition) -> Result<Self> {
        Ok(Self {
            nvs: EspNvs::new(partition, NAMESPACE, true)?,
        })
    }

    pub fn load_board_selection(&self, catalog: &[Board]) -> Result<BoardSelection> {
        let stored = self.optional_string(KEY_BOARD_ID);
        let custom_json = self.optional_board_descriptor().unwrap_or_else(|error| {
            log::warn!("stored custom board descriptor is unreadable: {error:#}");
            String::new()
        });
        let selection = board::select(
            catalog,
            (!stored.is_empty()).then_some(stored.as_str()),
            (!custom_json.is_empty()).then_some(custom_json.as_str()),
        )?;
        if let BoardSelection::Unknown { fallback, reason } = &selection {
            log::warn!("{reason}; opening setup with '{}'", fallback.id);
        }
        Ok(selection)
    }

    pub fn save_built_in_board(&self, board: &Board) -> Result<()> {
        board
            .validate()
            .map_err(|error| anyhow!("invalid board descriptor '{}': {error:?}", board.id))?;
        self.nvs.set_str(KEY_BOARD_ID, &board.id)?;
        self.nvs.remove(KEY_BOARD_DESCRIPTOR)?;
        Ok(())
    }

    /// Persist a validated custom board in its canonical serialization, so the
    /// stored bytes are exactly what boot will parse back.
    pub fn save_custom_board(&self, board: &Board) -> Result<()> {
        board
            .validate()
            .map_err(|error| anyhow!("invalid board descriptor '{}': {error:?}", board.id))?;
        let descriptor_json = serde_json::to_string(board)?;
        if descriptor_json.len() > MAX_BOARD_DESCRIPTOR_BYTES {
            bail!(
                "board descriptor is too large: {} bytes, max {}",
                descriptor_json.len(),
                MAX_BOARD_DESCRIPTOR_BYTES
            );
        }
        self.nvs.set_str(KEY_BOARD_DESCRIPTOR, &descriptor_json)?;
        self.nvs.set_str(KEY_BOARD_ID, &board.id)?;
        Ok(())
    }

    pub fn load(&self, board: &Board) -> Result<Option<RuntimeConfig>> {
        let schema = self.nvs.get_u8(KEY_SCHEMA)?;
        if schema.is_none() {
            return Ok(None);
        }
        // An incompatible schema may lack fields this build requires (such as the
        // admin secret). Treat it as unconfigured so the device re-commissions
        // cleanly instead of refusing to boot.
        if schema != Some(CONFIG_SCHEMA_VERSION) {
            log::warn!(
                "ignoring incompatible stored configuration schema {schema:?}; re-commissioning"
            );
            return Ok(None);
        }

        let config = RuntimeConfig {
            ssid: self.required_string(KEY_SSID)?,
            password: self.required_string(KEY_PASSWORD)?,
            target_host: self.required_string(KEY_TARGET_HOST)?,
            target_port: self.required_u16(KEY_TARGET_PORT)?,
            admin_secret: self.required_string(KEY_ADMIN_SECRET)?,
            // Optional: absent on stores written before names existed, so it
            // reads best-effort instead of forcing a schema bump that would
            // re-commission every upgraded device.
            device_name: self.optional_string(KEY_DEVICE_NAME),
            // Existing provisioned devices predate this optional key. They
            // adopt the appliance default without a destructive schema bump.
            auto_update_schedule: AutoUpdateSchedule::from_storage(
                self.nvs.get_u8(KEY_AUTO_UPDATE)?,
            ),
            audio: AudioSettings {
                input_line: self.required_u8(KEY_INPUT_LINE)?,
                input_gain: self.required_u8(KEY_INPUT_GAIN)?,
                adc_attenuation_db: self.required_u8(KEY_ADC_ATTENUATION)?,
            },
        };
        // A stored audio setting the selected board does not advertise opens
        // setup mode, so a device moved to different hardware can recover.
        match config.validate(board) {
            Ok(()) => Ok(Some(config)),
            Err(error) => {
                log::warn!(
                    "stored configuration is invalid for board descriptor '{}': {error:?}; re-commissioning",
                    board.id
                );
                Ok(None)
            }
        }
    }

    pub fn save(&self, config: &RuntimeConfig, board: &Board) -> Result<()> {
        config.validate(board).map_err(config_error)?;
        self.nvs.set_str(KEY_SSID, &config.ssid)?;
        self.nvs.set_str(KEY_PASSWORD, &config.password)?;
        self.nvs.set_str(KEY_TARGET_HOST, &config.target_host)?;
        self.nvs.set_u16(KEY_TARGET_PORT, config.target_port)?;
        self.nvs.set_str(KEY_ADMIN_SECRET, &config.admin_secret)?;
        self.nvs.set_str(KEY_DEVICE_NAME, &config.device_name)?;
        self.nvs
            .set_u8(KEY_AUTO_UPDATE, config.auto_update_schedule as u8)?;
        self.nvs.set_u8(KEY_INPUT_LINE, config.audio.input_line)?;
        self.nvs.set_u8(KEY_INPUT_GAIN, config.audio.input_gain)?;
        self.nvs
            .set_u8(KEY_ADC_ATTENUATION, config.audio.adc_attenuation_db)?;
        self.nvs.set_u8(KEY_SCHEMA, CONFIG_SCHEMA_VERSION)?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        for key in [
            KEY_SCHEMA,
            KEY_SSID,
            KEY_PASSWORD,
            KEY_TARGET_HOST,
            KEY_TARGET_PORT,
            KEY_ADMIN_SECRET,
            KEY_DEVICE_NAME,
            KEY_AUTO_UPDATE,
            KEY_BOARD_ID,
            KEY_BOARD_DESCRIPTOR,
            KEY_INPUT_LINE,
            KEY_INPUT_GAIN,
            KEY_ADC_ATTENUATION,
            KEY_LAST_FALLBACK,
            KEY_LAST_OTA,
        ] {
            self.nvs.remove(key)?;
        }
        Ok(())
    }

    /// Record why this boot fell back to the setup AP. Persisted so the
    /// evidence survives the reboot (or OTA rollback) that usually follows.
    pub fn save_last_fallback(&self, reason: &str) -> Result<()> {
        self.nvs
            .set_str(KEY_LAST_FALLBACK, truncate_utf8(reason, MAX_NOTE_BYTES))?;
        Ok(())
    }

    /// Record how the last OTA install attempt ended.
    pub fn save_last_ota(&self, outcome: &str) -> Result<()> {
        self.nvs
            .set_str(KEY_LAST_OTA, truncate_utf8(outcome, MAX_NOTE_BYTES))?;
        Ok(())
    }

    pub fn last_fallback(&self) -> String {
        self.optional_string(KEY_LAST_FALLBACK)
    }

    pub fn last_ota(&self) -> String {
        self.optional_string(KEY_LAST_OTA)
    }

    /// Best-effort string read for optional fields and diagnostic notes: a
    /// missing or unreadable value collapses to empty instead of failing.
    fn optional_string(&self, key: &str) -> String {
        let mut buffer = [0_u8; 256];
        self.nvs
            .get_str(key, &mut buffer)
            .ok()
            .flatten()
            .map(str::to_owned)
            .unwrap_or_default()
    }

    fn optional_board_descriptor(&self) -> Result<String> {
        let mut buffer = vec![0_u8; MAX_BOARD_DESCRIPTOR_BUFFER_BYTES];
        Ok(self
            .nvs
            .get_str(KEY_BOARD_DESCRIPTOR, &mut buffer)?
            .map(str::to_owned)
            .unwrap_or_default())
    }

    fn required_string(&self, key: &str) -> Result<String> {
        // ESP-IDF limits NVS string values to the partition entry capacity;
        // this upper bound comfortably covers WPA credentials and DNS hosts.
        let mut buffer = [0_u8; 256];
        self.nvs
            .get_str(key, &mut buffer)?
            .map(str::to_owned)
            .ok_or_else(|| anyhow::anyhow!("missing required configuration key: {key}"))
    }

    fn required_u8(&self, key: &str) -> Result<u8> {
        self.nvs
            .get_u8(key)?
            .ok_or_else(|| anyhow::anyhow!("missing required configuration key: {key}"))
    }

    fn required_u16(&self, key: &str) -> Result<u16> {
        self.nvs
            .get_u16(key)?
            .ok_or_else(|| anyhow::anyhow!("missing required configuration key: {key}"))
    }
}

fn config_error(error: ConfigError) -> anyhow::Error {
    anyhow::anyhow!("invalid stored configuration: {error:?}")
}

/// Truncate to at most `max` bytes without splitting a UTF-8 character.
fn truncate_utf8(value: &str, max: usize) -> &str {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}
