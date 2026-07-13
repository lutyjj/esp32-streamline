"""Constants for the StreamLine Home Assistant integration."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "streamline"
CONF_BRIDGE_URL = "bridge_url"
CONF_RECORDING_TOKEN = "recording_token"

PLATFORMS = (Platform.BINARY_SENSOR, Platform.SENSOR, Platform.SWITCH)
UPDATE_INTERVAL = timedelta(seconds=5)

SERVICE_START_RECORDING = "start_recording"
SERVICE_STOP_RECORDING = "stop_recording"
SERVICE_DELETE_RECORDING = "delete_recording"

ATTR_CONFIG_ENTRY_ID = "config_entry_id"
ATTR_SOURCE = "source"
ATTR_TITLE = "title"
ATTR_RECORDING_ID = "recording_id"

ACTIVE_RECORDING_STATES = frozenset({"waiting-for-audio", "recording", "finalizing"})
