# Changelog

Notable changes per release, grouped by type.
## [0.6.1]

### 🚀 Features
- Flows as data, and an input guide that owns passthrough
- Guide encryption setup in the shared wizard sheet
- One bridge lock, guided encryption, and a Toggle primitive
- One API token and console-switched encryption
- Add local analog output

### 🐛 Bug Fixes
- Keep an armed inline confirm where its trigger stood
- Bridge polling died after one tick; one input meter
- One name for the input meter
- Keep action rows with their section
- Consistent Encryption section, unblocked reboot wait, lock gating
- Close the guided-setup seams from the second test round
- Void a pending verification when the stream target changes
- Match esp-tls error records as they are captured
- Name the real cause of a failed TLS connection

### 🚜 Refactor
- Require the complete transport state shape

## [0.6.0]

### 🚀 Features
- Guide the whole bridge hookup with a setup wizard
- Let a parent control a Disclosure
- Let owners discard the pending PCM key
- Report secure transport failures
- Manage secure PCM transport
- Define TLS 1.3 PCM transport contract
- Authenticate PCM with TLS 1.3 PSK
- Secure PCM transport with per-device keys

### 🐛 Bug Fixes
- Declare and smoke rollback conflict as 409
- Make dismissing the one-time PSK reveal unmistakable
- Integrate secure transport with design system
- Enforce the secure TLS profile
- Size HTTP stack for key writes
- Cut over when activating transport key
- Give the New recording form a full-width action row
- Polish masthead controls and bridge recording UI

### 🚜 Refactor
- Give mutation failures typed HTTP statuses
- Make stream runtime policies host-testable
- Move calibration restore-on-cancel into the engine
- Rebuild the encryption section from the design system
- Persist the PCM PSK as its hex form
- Move admin-key replacement into a tested step
- Extract stream-target host validation
- Move audio-profile edits into tested rules
- Default transport control to one disabled listener
- Fold transport failure kinds into one handshake flag
- Use one mutually exclusive PCM listener
- Split the analysis library into purpose-named modules
- Fold bridge storage into the New recording card
- Unify the device and bridge design system

### 📚 Documentation
- Match the Recovery sub-section label
- Describe the single PCM listener
- Document encrypted PCM operation
- Choose encrypted PCM transport

## [0.5.7]

### 🚀 Features
- Drive the QEMU smoke through pytest-embedded
- Add QEMU image variant with emulated ethernet
- Add theme preference
- Add live source console
- Add boot and API smoke harness for QEMU and USB devices

### 🐛 Bug Fixes
- Complete reboot responses before restarting
- Make board state recovery-safe
- Keep recording polling resilient
- Keep repeated recording scans current

### 🚜 Refactor
- Make HTTP policies host-testable
- Split HTTP adapter by concern
- Split the device library into purpose-named modules
- Make the smoke suite device-agnostic
- Give each image variant one named boot function
- Centralize browser preferences
- Derive console from API contract

## [0.5.6]

### 🐛 Bug Fixes
- Show the firmware version with a live status dot
- Rebuild the recordings console and serve it through HA ingress

## [0.5.5]

### 🚀 Features
- Unify navigation and design system

### 🐛 Bug Fixes
- Keep recordings out of backups

### 🚜 Refactor
- Generate API client with Orval
- Simplify dependency ownership

## [0.5.4]

### 🚀 Features
- Configure recording storage
- Add recording workspace
- Expose recording API
- Add lossless recording core

### 🐛 Bug Fixes
- Preserve the upstream dependency contract
- Enforce runtime validation invariants
- Secure host-facing boundaries
- Harden recording writes
- Align API endpoint descriptions (#141)
- Arm reboot waits after acknowledgement (#140)
- Add explicit docker.io registry prefix to container images (#137)

### 🚜 Refactor
- Keep uv out of runtime images
- Normalize audio-setting vocabulary and derive console import constraints (#143)
- Separate playout and source contracts (#142)

### 📚 Documentation
- Design lossless bridge recordings
- Remove internal note from customer-facing changelog (#138)

## [0.5.3]

### 🐛 Bug Fixes
- Enforce generated changelog (#117)
- Polish API contract layout (#116)

### 📚 Documentation
- Document architecture and debt audit (#136)

## [0.5.2]

### 🚀 Features
- Derive device contract and console client (#115)
- Add status light (#114)

## [0.5.1]

### 🚀 Features
- Add source audio profiles (#111)
- Add automatic update schedules (#98)
- Share the console build (#95)
- Log source connect/disconnect via the logging module

### 🐛 Bug Fixes
- Serve manifest during development (#97)
- Don't report an OTA rollback before the device reboots (#94)

### 🚜 Refactor
- Simplify issue templates (#101)

### 📚 Documentation
- Lead with the Home Assistant add-on to Music Assistant path

## [0.5.0]

### 🚀 Features
- Adopt 4 MB flash partition layout (#90)
- Split network settings into wifi and target endpoints (#89)

## [0.4.2]

### 🐛 Bug Fixes
- Run HA add-on with Supervisor data access

### ⚡ Performance
- Read rollback availability once at boot

## [0.4.1]

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

## [0.4.0]

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

## [0.3.4]

### 🚀 Features
- Expose firmware prometheus metrics

### 🐛 Bug Fixes
- Require explicit Wi-Fi password changes

## [0.3.3]

### 🚀 Features
- Install pinned custom images over the air

### 🐛 Bug Fixes
- Verify unlock keys and harden the OTA flow
- Harden source selection and error reporting

## [0.3.2]

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

## [0.3.1]

### 🚀 Features
- Generate admin key during setup (#26)
- Add browser-based firmware installer (#24)
- Add silence detection to stop idle streaming (#23)
- Separate OTA check from install and redesign the update panel (#21)
- Add bounded non-interactive serial capture

### 🐛 Bug Fixes
- Correct browser support and clean-install copy

## [0.3.0]

### 🚀 Features
- Add verified OTA firmware updates

### 🐛 Bug Fixes
- Resolve OTA update issues with SNTP sync and GitHub redirects

### 🚜 Refactor
- Extract verifying-download pipeline behind host-testable traits

### 📚 Documentation
- Add core/adapter coding standards to AGENTS.md

## [0.2.1]

### 🚀 Features
- Authenticate mutating HTTP API with a console secret (#13)

### 📚 Documentation
- Prioritize pre-built artifacts in quickstart (#15)

## [0.2.0]

### 🚜 Refactor
- Isolate component build environments (#3)

## [0.1.2]

### 🐛 Bug Fixes
- Publish one-file firmware release image (#2)

## [0.1.1]

### 🚜 Refactor
- Organize components and release flow (#1)

### 📚 Documentation
- AI attribution
- Add AGENTS.md

## [0.1.0]

### 🚀 Features
- 0.1.0


