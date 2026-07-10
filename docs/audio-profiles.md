# Audio profiles

Audio profiles give one source a name and one complete set of input controls:
source line, input gain, and ADC attenuation. Applying a profile writes those
controls to the running codec immediately and persists them for the next boot.

The device stores up to eight profiles. A profile catalog is versioned and
bound to a board descriptor because input lines and level limits are hardware
facts. The firmware rejects duplicate IDs, invalid references, wrong-board
imports, out-of-range settings, and names longer than 32 characters.

## Data contract

`GET /api/audio-profiles` returns the shareable catalog:

```json
{
  "schema_version": 1,
  "board_id": "ai-thinker-esp32-audio-kit-v2-2-es8388",
  "active_profile_id": "vinyl",
  "profiles": [
    {
      "id": "vinyl",
      "name": "Vinyl",
      "audio": {
        "input_line": 2,
        "input_gain": 7,
        "adc_attenuation_db": 12
      }
    }
  ]
}
```

The Rust types in `firmware/streamline/src/profiles.rs` own this contract.
NVS and HTTP JSON are storage and transport representations of those validated
types. The TypeScript interfaces and import parser in `console/src/lib` mirror
the device contract.

NVS stores each profile as a separate short record plus catalog metadata and
the active ID. This fits NVS's small-value design and avoids requiring one
large contiguous string allocation. Raw applied audio settings remain in the
main configuration, so a catalog write cannot leave the codec without a known
boot configuration. At boot, an active ID is kept only when its profile matches
the applied settings.

## API

Reads are open. Writes use the admin-key bearer token.

Replace the saved definitions with a validated catalog:

```sh
curl -X POST http://192.0.2.10/api/settings/audio-profiles \
  -H "Authorization: Bearer $ADMIN_KEY" \
  --data-urlencode 'catalog={"schema_version":1,"board_id":"ai-thinker-esp32-audio-kit-v2-2-es8388","active_profile_id":null,"profiles":[]}'
```

This collection write never changes live levels. It preserves the active
profile when that definition still matches the applied settings; deleting or
changing it returns the device to custom settings.

Apply a profile:

```sh
curl -X POST http://192.0.2.10/api/settings/audio-profile \
  -H "Authorization: Bearer $ADMIN_KEY" \
  --data-urlencode 'profile_id=vinyl'
```

An empty `profile_id` returns to custom settings without changing levels.
Posting raw settings to `/api/settings/audio` or running calibration also
returns to custom settings.

The console can create, update, delete, apply, export, and import the same
catalog. Import replaces saved definitions, requires the same board ID, and
never imports another device's active selection.

## Switching sources

Profile activation is explicit. StreamLine does not infer a source from its
waveform: a quiet CD master can overlap a loud vinyl recording, and choosing
the wrong gain automatically can clip the capture.

Automatic switching belongs at a source that knows the selector's real state.
A Home Assistant automation, smart switch, or GPIO-aware selector can call
`POST /api/settings/audio-profile` when the physical source changes. The
activation endpoint is the stable seam; trigger strategies stay outside the
profile model and do not change its storage or console contract.
