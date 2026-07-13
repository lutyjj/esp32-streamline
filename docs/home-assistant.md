# Home Assistant integration

The StreamLine custom integration turns each bridge source into a Home
Assistant device with streaming, level, and recording entities. The
[bridge](bridge.md) runs the audio service — as the add-on or the standalone
container — and the integration polls its HTTP API. The integration requires
Home Assistant 2026.7 or newer.

## Install

1. Run a bridge reachable from Home Assistant: the
   [StreamLine bridge add-on](../ha-addon/README.md) or the standalone
   container with HTTP port `8088` open.
2. In HACS, open **Custom repositories**, add
   `https://github.com/lutyjj/esp32-streamline`, and select type
   **Integration**.
3. Download **ESP32 StreamLine**, then restart Home Assistant.
4. Open **Settings → Devices & services → Add integration → ESP32 StreamLine**
   and enter the bridge root URL, such as `http://192.0.2.1:8088`.

Enter the bridge API root, not the add-on ingress URL: ingress is a browser
path, not an API. For the add-on, use the Home Assistant host address with the
add-on's published HTTP port.

Add the bridge's recording token to enable the recording switch; status
entities need no token. The integration verifies the URL and token before
saving them.

## Entities

The integration polls bridge `/status` every five seconds and adds entities
when a source appears. A source that the bridge evicts keeps its Home
Assistant device; its entities stay unavailable until the source returns. The
bridge identifies a source by its IPv4 address, so use stable addresses or
DHCP reservations when entity identity must survive network changes.

| Entity | Contract |
| --- | --- |
| Audio streaming | On while the bridge reports an active PCM producer connection. It may stay on for the source idle timeout after audio stops. |
| Peak level | Higher of the latest left and right PCM peaks as `0–100 %`. |
| Recording | On while this source owns an active recording session. Turning it on starts a recording with a timestamped title; turning it off stops and finalizes it. Unavailable without a recording token or recording storage. |
| Listeners | Current live-WAV client count (diagnostic). |
| Lost packets | Cumulative bridge loss counter (diagnostic, disabled by default). |

The [recording API](recordings.md#api) owns the session lifecycle behind the
recording switch; the bridge page and Home Assistant call the same contract.

## Reconfigure and remove

Use **Settings → Devices & services → ESP32 StreamLine → Reconfigure** to
replace the bridge URL or recording token. Home Assistant opens a repair flow
when the bridge rejects the saved token.

Removing the config entry removes its devices and entities; HACS removes the
integration files separately. Neither deletes bridge recordings.

Device Wi-Fi, audio controls, profiles, firmware, and stream-target settings
stay on the device console and API; the integration does not duplicate the
device configuration contract.
