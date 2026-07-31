"""Attribute the firmware ELF's flash bytes to their owners.

The OTA slot is the firmware's scarcest resource (issue #355): images are
signed in 64 KB buckets and the release gate blocks at 93% of the slot. This
package answers "who spent the bytes" so a diff's flash cost is reviewable
before the gate refuses it: `archives` maps defined symbols to the ESP-IDF
component or prebuilt blob that owns them, `symbols` reads the linked ELF and
names each Rust symbol's crate, and `report` aggregates both into the table
`make firmware-size-report` prints.
"""
