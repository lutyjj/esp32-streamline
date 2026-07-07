# Changelog

Notable changes per release, grouped by type. Generated from Conventional
Commits with git-cliff — do not edit by hand.
## [0.5.0] - 2026-07-07

### 🚀 Features
- Adopt 4 MB flash partition layout (#90)
- Split network settings into wifi and target endpoints (#89)

## [0.4.2] - 2026-07-06

### 🐛 Bug Fixes
- Run HA add-on with Supervisor data access

### ⚡ Performance
- Read rollback availability once at boot

## [0.4.1] - 2026-07-06

### 🚀 Features
- Package bridge as Home Assistant add-on (#85)
- Drive boards from JSON descriptors with custom upload (#83)
- Resolve board preset at boot
- Drive audio pins from board descriptors (#81)
- Route codec setup through board descriptors (#80)
- Board descriptor drives capabilities, validation, and the console (#79)

### 🐛 Bug Fixes
- One honest handoff for the first join (#78)
- Make the clip callout dismissible

### 🚜 Refactor
- Small DRY cleanups from the console review
- Wizard reuses the meter row
- One KeyReveal for every admin-key handoff
- Render the transact lifecycle through one component

### 📚 Documentation
- Define the user journey as the UX contract
- Every capability is an API first
- Testing, on-device proof, journey, and privacy rules

## [0.4.0] - 2026-07-04

### 🚀 Features
- Reimplement console component
- Advertise console over mdns (#65)
- Guided input-level calibration wizard (#63)
- Configurable device name (#60)
- Apply audio settings without rebooting (#59)
- Rebuild the web console on one design system (#54)

### 🐛 Bug Fixes
- Gate locked console controls generically (#64)
- Calibrate play detection to the tracked idle level (#53)
- Keep OTA partition table when flashing over serial (#50)

### 🚜 Refactor
- Structure API paths around nouns and verbs (#61)

## [0.3.4] - 2026-07-03

### 🚀 Features
- Expose firmware prometheus metrics

### 🐛 Bug Fixes
- Require explicit Wi-Fi password changes

## [0.3.3] - 2026-07-03

### 🚀 Features
- Install pinned custom images over the air

### 🐛 Bug Fixes
- Verify unlock keys and harden the OTA flow
- Harden source selection and error reporting

## [0.3.2] - 2026-07-02

### 🚀 Features
- Support multiple TCP producers (#41)

### 🐛 Bug Fixes
- Make OTA start atomic and tolerate junk in SHA256SUMS
- Rewrite play detection with amplitude and time hysteresis

### 🚜 Refactor
- Structure the console for maintainability
- Converge components on one shared Makefile contract

### 📚 Documentation
- Require meaningful unit tests (#42)
- Rewrite for concision, active voice, and single-source facts
- Refresh to current state

## [0.3.1] - 2026-07-01

### 🚀 Features
- Generate admin key during setup (#26)
- Add browser-based firmware installer (#24)
- Add silence detection to stop idle streaming (#23)
- Separate OTA check from install and redesign the update panel (#21)
- Add bounded non-interactive serial capture

### 🐛 Bug Fixes
- Correct browser support and clean-install copy

## [0.3.0] - 2026-06-22

### 🐛 Bug Fixes
- Resolve OTA update issues with SNTP sync and GitHub redirects

### 🚜 Refactor
- Extract verifying-download pipeline behind host-testable traits

### 📚 Documentation
- Add core/adapter coding standards to AGENTS.md

## [0.2.2] - 2026-06-20

### 🚀 Features
- Add verified OTA firmware updates

## [0.2.1] - 2026-06-20

### 🚀 Features
- Authenticate mutating HTTP API with a console secret (#13)

### 📚 Documentation
- Prioritize pre-built artifacts in quickstart (#15)

## [0.2.0] - 2026-06-20

### 🚜 Refactor
- Isolate component build environments (#3)

## [0.1.2] - 2026-06-19

### 🐛 Bug Fixes
- Publish one-file firmware release image (#2)

## [0.1.1] - 2026-06-19

### 🚜 Refactor
- Organize components and release flow (#1)

### 📚 Documentation
- AI attribution
- Add AGENTS.md

## [0.1.0] - 2026-06-19

### 🚀 Features
- 0.1.0


