# Home Assistant integration

The StreamLine custom integration turns each bridge source into a Home
Assistant device and exposes saved bridge recordings in **Media**. The bridge
add-on runs the audio service. The integration registers Home Assistant
entities, actions, and the media source.

The integration requires Home Assistant 2026.7 or newer. Install it with HACS
from this repository; a separate integration repository is not required.

## Install

1. Install and configure the [StreamLine bridge add-on](../ha-addon/README.md),
   or run the standalone bridge with HTTP port `8088` reachable from Home
   Assistant.
2. In HACS, open **Custom repositories**, add
   `https://github.com/lutyjj/esp32-streamline`, and select **Integration**.
3. Download **ESP32 StreamLine**, then restart Home Assistant.
4. Open **Settings → Devices & services**. Confirm the discovered StreamLine
   add-on, or select **Add integration → ESP32 StreamLine** and enter the bridge
   root URL.

The add-on discovery message supplies its internal host, HTTP port, and
recording token. Manual setup accepts a direct root URL such as
`http://streamline-bridge.local:8088`. Add the recording token to enable
recording controls and media; status entities need no token.

The bridge and integration poll over the Home Assistant or Docker internal
network. Keep port `8088` reachable on that network. Do not enter the add-on
ingress URL: ingress is a browser path, not the bridge API root.

## Entities

The integration adds entities when a source appears in bridge `/status`. A
dynamic source remains a Home Assistant device after the bridge evicts its
inactive pipeline; its entities become unavailable until the source returns.

| Entity | Contract |
| --- | --- |
| Audio streaming | On while the bridge reports an active PCM producer connection. It may remain on for the configured source idle timeout after audio stops. |
| Peak level | Higher of the latest left and right PCM peaks, normalized to `0–100%`. |
| Recording | Starts a recording with a timestamped title; turning it off stops and finalizes that source's active session. |
| Listeners | Current live-WAV client count. |
| Lost packets | Cumulative bridge loss counter. Disabled by default. |

The bridge identifies a source by its IPv4 address. Use stable addresses or
DHCP reservations when entity identity must survive network changes.

## Actions

Actions expose recording commands with explicit inputs for dashboards,
automations, scripts, and agents.

| Action | Required data |
| --- | --- |
| `streamline.start_recording` | `config_entry_id`, source IPv4 address, and a title of 1–80 characters |
| `streamline.stop_recording` | `config_entry_id` and active `recording_id` |
| `streamline.delete_recording` | `config_entry_id` and inactive `recording_id` |

Use the bridge API when a workflow needs to list IDs before calling an action.
The [recording API](recordings.md#api) remains the source contract behind both
the bridge page and Home Assistant.

## Media

Open **Media → StreamLine → _bridge_** to browse finalized WAV files. Active
sessions appear after the bridge finalizes them. Selecting a file resolves a
Home Assistant media URL; Home Assistant then creates a fresh one-use bridge
download ticket and proxies the WAV bytes to the player. Recording tokens and
bridge tickets never appear in media IDs or player URLs.

This proxy lets Home Assistant and Music Assistant play files from an internal
add-on hostname and keeps playback behind Home Assistant authentication. The
bridge remains the file owner. Deleting or uninstalling its add-on removes its
working files as described in [lossless recordings](recordings.md).

## Reconfigure and remove

Use **Settings → Devices & services → ESP32 StreamLine → Reconfigure** to
replace the bridge URL or recording token. Home Assistant opens a credential
repair flow when the bridge rejects a saved token.

Remove the config entry to remove its devices, entities, actions target, and
media folder. HACS removes the integration files separately. Neither operation
deletes bridge recordings.

Device Wi-Fi, audio controls, profiles, firmware, and stream-target settings
remain on the device API and console. Home Assistant owns bridge observation,
recording control, and playback; it does not duplicate the device configuration
contract.
