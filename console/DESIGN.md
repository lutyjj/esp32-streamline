# Console design

The console is a home-audio control surface. [Product context](PRODUCT.md)
owns its audience and delivery constraints; the [user journey](../docs/user-journey.md)
owns behavior.

## Everyday use

Audio leads with the physical input and live level. Saved profiles sit alongside
that feedback. Adjust input opens a focused editor; calibration is a guided task.
The editor keeps a compact meter visible while scrolling through controls.
Signal counters and profile administration use secondary disclosures.

Listen on the bridge joins reception and the player handoff. Record this audio
opens the recording composer for that source. Recording progress, remaining
storage, and errors stay near the action they describe.

## Navigation and editing

The device has Audio and Settings. The bridge has Listen, Recordings, and
Settings. A desktop rail holds those destinations; a phone uses bottom navigation.
Settings is an index of named tasks. Each task has a URL and a return link;
there is no second persistent navigation column inside the content.

A draft stays separate from applied state. Navigating away preserves it for the
page session. Save confirms a write, Discard restores applied values, and a
pending write disables its editor. Destructive dialogs name the affected item,
explain the consequence, and focus Cancel.

## Visual system

Neutral graphite text on white surfaces supports daytime use. Dark mode uses
light text on charcoal surfaces. Blue identifies actions and focus; green,
amber, and red communicate measured status. Text maintains at least 4.5:1
contrast. Do not use a muted color to make necessary instructions disappear.

One bundled sans-serif family serves headings and controls. Monospace is for
addresses, measurements, and code. Fields, selectors, and buttons share a
44-pixel control height and an eight-pixel radius. Native select menus keep
platform keyboard and touch behavior; their closed controls use the same
surface, border, padding, and arrow treatment.

Spacing separates tasks. Surfaces group editing contexts. Dividers belong only
where rows need separation, not around every heading or disclosure. Motion
communicates an operation or state change and respects reduced motion.

## Ownership

The shell owns navigation and workspace placement. Shared primitives own
controls and sections. Audio, bridge, settings, and system styles live with their
feature components. All styles still compile into each offline HTML artifact.
No component depends on another component's runtime styling service.
