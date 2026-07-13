"""Constants for the StreamLine Home Assistant integration."""

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "streamline"
CONF_BRIDGE_URL = "bridge_url"
CONF_RECORDING_TOKEN = "recording_token"

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR, Platform.SWITCH]
UPDATE_INTERVAL = timedelta(seconds=5)
