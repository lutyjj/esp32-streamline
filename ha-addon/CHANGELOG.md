# Changelog

Notable changes per release, grouped by type.
## [0.11.1](https://github.com/lutyjj/esp32-streamline/compare/v0.11.0...v0.11.1) (2026-08-01)


### Bug Fixes

* **console:** stop the browser prompting for credentials on unlock ([0389158](https://github.com/lutyjj/esp32-streamline/commit/038915808f1666724f8c317c12c0fa2abc524650))
* **firmware:** hold one TLS receive buffer for the whole OTA download ([741ca6a](https://github.com/lutyjj/esp32-streamline/commit/741ca6a449b21a1c8fa394f79c1f791996d1d747)), closes [#373](https://github.com/lutyjj/esp32-streamline/issues/373)

## [0.11.0](https://github.com/lutyjj/esp32-streamline/compare/v0.10.0...v0.11.0) (2026-07-31)


### ⚠ BREAKING CHANGES

* **firmware:** prove the admin key with digest auth and make the setup password device identity

### Features

* **firmware:** prove the admin key with digest auth and make the setup password device identity ([d58ed51](https://github.com/lutyjj/esp32-streamline/commit/d58ed5120913e4433785bc25e9d02efb5a6a18f2))


### Bug Fixes

* **ci:** inherit secrets when release-please chains to publish ([#369](https://github.com/lutyjj/esp32-streamline/issues/369)) ([d0fe186](https://github.com/lutyjj/esp32-streamline/commit/d0fe186255a89865599893f6065f262906f1b081))
* **firmware:** make the OTA quiesce handshake explicit and stop regenerating the setup password on a read error ([799a0ed](https://github.com/lutyjj/esp32-streamline/commit/799a0ede8d11be92c928130419513c19ea0b3b8e))
* **firmware:** make the OTA quiesce handshake explicit; stop regenerating the setup password on a read error ([#370](https://github.com/lutyjj/esp32-streamline/issues/370)) ([799a0ed](https://github.com/lutyjj/esp32-streamline/commit/799a0ede8d11be92c928130419513c19ea0b3b8e))
* **tools:** keep pytest away from the admin-key descriptor in smoke-device ([29d4b14](https://github.com/lutyjj/esp32-streamline/commit/29d4b14e0037991959c6ed195cfb754bb9390d7e))


### Performance Improvements

* **tools:** run the QEMU smoke suite in parallel with SMOKE_JOBS ([08524a1](https://github.com/lutyjj/esp32-streamline/commit/08524a12022b48f1c41fbf2b806d76f02e119cfe))

## [0.10.0](https://github.com/lutyjj/esp32-streamline/compare/v0.9.0...v0.10.0) (2026-07-31)


### Features

* **console:** read the device log from System ([7007672](https://github.com/lutyjj/esp32-streamline/commit/7007672a2fb95839cab64df3473b702caedf0c89))
* **firmware:** capture a panic's core dump and serve it over the API ([c9554d4](https://github.com/lutyjj/esp32-streamline/commit/c9554d48592098ecb500c0eb56c1262a590bbaa1))
* **firmware:** open the setup AP for one boot when a button is held at power-on ([ef4fcba](https://github.com/lutyjj/esp32-streamline/commit/ef4fcba71f0934b64c76407b5605784d2a527b99))
* **firmware:** protect the setup AP with a per-device WPA2 password ([32f5910](https://github.com/lutyjj/esp32-streamline/commit/32f5910a9f5ec16e725e59ec1f824ee30094043e))
* **firmware:** report OTA signature enforcement and name rejections ([167b63d](https://github.com/lutyjj/esp32-streamline/commit/167b63d95add1c2b56a3873426464a91b70cefe3))
* **firmware:** serve the device log at /api/logs ([d8cd049](https://github.com/lutyjj/esp32-streamline/commit/d8cd049f8705f9cd0c2af4cac6b12f748d5a40b7))
* **firmware:** shrink the OTA image by 192 KB ([bb16232](https://github.com/lutyjj/esp32-streamline/commit/bb162320b10dd250a7dee0ee13291c9dba7e26ab))
* **firmware:** store the embedded console and OpenAPI artifact gzipped ([5061547](https://github.com/lutyjj/esp32-streamline/commit/5061547f0969e1fbfcee5d80a3c92425a568b522))
* **firmware:** verify vendor RSA-3072 signatures on OTA images ([3c8aef1](https://github.com/lutyjj/esp32-streamline/commit/3c8aef1689ed07d53e4e3d012b2e7d3feda87016))
* **tools:** attribute firmware flash bytes with make firmware-size-report ([3612722](https://github.com/lutyjj/esp32-streamline/commit/361272238a1c83506bf1890c00d0ac59857216bf))


### Bug Fixes

* **firmware:** package the two-slot OTA table in the full image ([824790f](https://github.com/lutyjj/esp32-streamline/commit/824790ffdd88c4a15b9d9fc6b06d0e5a48e5dff3))
* **firmware:** pause streaming during an OTA install so it cannot panic ([#366](https://github.com/lutyjj/esp32-streamline/issues/366)) ([62a2bb5](https://github.com/lutyjj/esp32-streamline/commit/62a2bb51b510066d13d17d791601170a9330f8af)), closes [#335](https://github.com/lutyjj/esp32-streamline/issues/335)
* **firmware:** treat the log hook as a stream, not a line at a time ([07eeaec](https://github.com/lutyjj/esp32-streamline/commit/07eeaec7413ed3bfa99f48419ccffac7ab1beec0))
* **firmware:** use dynamic mbedTLS buffers so the update check survives streaming ([36bff18](https://github.com/lutyjj/esp32-streamline/commit/36bff188d5ac48d2910f383be9af1f0d2143a491)), closes [#334](https://github.com/lutyjj/esp32-streamline/issues/334)
* identify the boot a log line belongs to ([1a142ad](https://github.com/lutyjj/esp32-streamline/commit/1a142ad481cca92afa7cbc5dc7eafb8b4deadf74))

## [0.9.0](https://github.com/lutyjj/esp32-streamline/compare/v0.8.1...v0.9.0) (2026-07-23)


### Features

* **console:** raise a critical callout while audio is dropping ([9497752](https://github.com/lutyjj/esp32-streamline/commit/94977525412624749ef051ed0d9d030ecfcac8c8))
* **firmware:** count and log send stalls ([e058ec4](https://github.com/lutyjj/esp32-streamline/commit/e058ec405fa0dcad3ef9903eb2039274308da97a))


### Bug Fixes

* **firmware:** disable Nagle on the TLS PCM socket and keep the radio awake ([069f0b9](https://github.com/lutyjj/esp32-streamline/commit/069f0b96d80f10286cd8eb3e039fb834bcd1658f))
* **firmware:** keep the audio pipeline above httpd in task priority ([cb76274](https://github.com/lutyjj/esp32-streamline/commit/cb76274b69a4d9ad5c87f381dfecd811840c381c))
* **firmware:** stop status reads from spinning the stream counters ([006bc51](https://github.com/lutyjj/esp32-streamline/commit/006bc515dce8d9b2ee70e261de69e2707baf77b3))
* **firmware:** stream HTTP bodies instead of materializing them ([3e83359](https://github.com/lutyjj/esp32-streamline/commit/3e83359bbc96c4e0f3ec304ad10a43c53556ddf7))

## [0.8.1](https://github.com/lutyjj/esp32-streamline/compare/v0.8.0...v0.8.1) (2026-07-21)


### Bug Fixes

* **bridge:** bound HTTP ingress bodies and stalled progress ([#327](https://github.com/lutyjj/esp32-streamline/issues/327)) ([bc4a113](https://github.com/lutyjj/esp32-streamline/commit/bc4a113972a7aed401c8e75e4302d6a20134f1bc))
* **bridge:** close evicted pipelines and bound playout admission ([#326](https://github.com/lutyjj/esp32-streamline/issues/326)) ([3cd0434](https://github.com/lutyjj/esp32-streamline/commit/3cd0434dfd7747c5ad7055525b2d8ec243f6d8d0))
* **bridge:** reject exposed transport state files ([#322](https://github.com/lutyjj/esp32-streamline/issues/322)) ([7c18517](https://github.com/lutyjj/esp32-streamline/commit/7c1851747cbac7956e4a4f69179e9b91e26b5064))
* **bridge:** revoke live TLS sessions on transport key mutation ([#328](https://github.com/lutyjj/esp32-streamline/issues/328)) ([b4f9aaa](https://github.com/lutyjj/esp32-streamline/commit/b4f9aaa21ea14235300b326fd7cb0f148673a409))
* **ci:** publish releases only for promoted mainline commits ([#329](https://github.com/lutyjj/esp32-streamline/issues/329)) ([3a92050](https://github.com/lutyjj/esp32-streamline/commit/3a92050568933591be300da422887a7c871f881e))
* **ota:** keep custom image URLs out of diagnostics ([#325](https://github.com/lutyjj/esp32-streamline/issues/325)) ([958348b](https://github.com/lutyjj/esp32-streamline/commit/958348b526ec11bad98a0ef7f83ddf57b1dc9906))
* **tools:** keep device credentials off process metadata ([#323](https://github.com/lutyjj/esp32-streamline/issues/323)) ([ef409bd](https://github.com/lutyjj/esp32-streamline/commit/ef409bdfbc3f5302c0808a764eae8f0202aae435))

## [0.8.0](https://github.com/lutyjj/esp32-streamline/compare/v0.7.2...v0.8.0) (2026-07-20)


### Features

* **console:** button action assignment and paused-streaming recovery ([e7aaa10](https://github.com/lutyjj/esp32-streamline/commit/e7aaa1014a312afcebef12d5238884aba96f08f8))
* **console:** Playwright journey specs against the mock backends ([89fead1](https://github.com/lutyjj/esp32-streamline/commit/89fead11f2c054a2138a78b96694da3c77f2bcc0))
* **console:** stateful mock backends for both consoles ([97754e4](https://github.com/lutyjj/esp32-streamline/commit/97754e4584a09ca796ba7365863b4acb2d63ba1e))
* **firmware:** assignable button actions and streaming pause ([9db8ba2](https://github.com/lutyjj/esp32-streamline/commit/9db8ba29e57e462bb1bf3990fd72ac783d981e89))
* **firmware:** carry the canonical example device in the contract ([952057d](https://github.com/lutyjj/esp32-streamline/commit/952057de135220fb89decdc370ba89fd2b9a1c2a))
* **firmware:** gain and attenuation step actions ([cb62faf](https://github.com/lutyjj/esp32-streamline/commit/cb62faf44b1c9b6866989481e93f1f6a49186d7f))


### Bug Fixes

* **api:** declare the complete mutation outcome taxonomy per endpoint ([1ab19e7](https://github.com/lutyjj/esp32-streamline/commit/1ab19e7da8f26d9db4f098c300e0ec99e71a482e)), closes [#231](https://github.com/lutyjj/esp32-streamline/issues/231)
* **console:** carry modal, announcement, and control semantics in the primitives ([d2ce3f0](https://github.com/lutyjj/esp32-streamline/commit/d2ce3f0ce89d4b3dfb7302c725fd03f8fffb3d69))
* **console:** centralize bridge authorization at the contract boundary ([b97cb8f](https://github.com/lutyjj/esp32-streamline/commit/b97cb8f7cb4c20a4e44a611c2f37509d553d8f59))
* **console:** end open disclosures at intrinsic height ([d4d6f3f](https://github.com/lutyjj/esp32-streamline/commit/d4d6f3f0b518d8f2bb8debf0d0f004c85116ea92))
* **console:** follow live device audio in the Audio tab controls ([8d22893](https://github.com/lutyjj/esp32-streamline/commit/8d2289346d70551d07e3a9dbcd7e4cce2533b72a))
* **console:** generate curl examples that authenticate and stay contract-true ([c022baa](https://github.com/lutyjj/esp32-streamline/commit/c022baadc5e83c1736340e0a2e99eb14cc940a44))
* **console:** keep local actions usable when locked and confirm destruction ([b1c37ec](https://github.com/lutyjj/esp32-streamline/commit/b1c37ec5fc9ed85116a556068a48a8be307f1d5b))
* **console:** make custom OTA a validated source-aware transaction ([f561118](https://github.com/lutyjj/esp32-streamline/commit/f5611182325d32bb497e00d540943175c12b0c03))
* **console:** make log text readable in the default theme ([4f01cd6](https://github.com/lutyjj/esp32-streamline/commit/4f01cd65a50159ef5c084f814fe574856ccb6664))
* **console:** model device settings as a failure-aware resource ([5aa1285](https://github.com/lutyjj/esp32-streamline/commit/5aa1285d8869326c82045553c9a74485753233c7))
* **console:** put storage and clipboard behind failure-aware custody ([1feb7d0](https://github.com/lutyjj/esp32-streamline/commit/1feb7d08a2568f51b2856d952c27fa35888a9e70))
* **console:** register the stale-drop counter in the metrics fixture ([f0cf115](https://github.com/lutyjj/esp32-streamline/commit/f0cf1153ea3d1af979460076530a44ff1d824c55))
* **console:** render the recording contract with explicit resource states ([fb978e4](https://github.com/lutyjj/esp32-streamline/commit/fb978e41138cd756d4c17247da8ab12bda9086f7))
* **console:** snapshot audio profiles from live status, not stale settings ([4d76248](https://github.com/lutyjj/esp32-streamline/commit/4d76248c21998d1b288231bcaf19234206597d9a))
* **console:** treat factory reset as a setup-network handoff ([6805859](https://github.com/lutyjj/esp32-streamline/commit/6805859d444463c230c31b07a328abae2e7da709))
* **firmware:** bound in-flight packet retry to the queue's latency budget ([b79cebb](https://github.com/lutyjj/esp32-streamline/commit/b79cebb0c6d99c0987f4a0948a6441b6257eef96)), closes [#224](https://github.com/lutyjj/esp32-streamline/issues/224)
* **firmware:** expire playback and account the timeline through capture stalls ([8e5edee](https://github.com/lutyjj/esp32-streamline/commit/8e5edeedc6567f3b7b818d3ae162bf18c6677a97)), closes [#225](https://github.com/lutyjj/esp32-streamline/issues/225)
* **firmware:** keep button-press stacks off the OTA check's heap margin ([6a4693e](https://github.com/lutyjj/esp32-streamline/commit/6a4693ebe9483561aa6b78f0415647e048386cb3))
* **firmware:** validate admin keys against one exact generated shape ([21106ff](https://github.com/lutyjj/esp32-streamline/commit/21106ffcef054891dcf99ee403ed57778de45146)), closes [#229](https://github.com/lutyjj/esp32-streamline/issues/229)
* **protocol:** coalesce short capture reads into fixed 256-frame packets ([392acc8](https://github.com/lutyjj/esp32-streamline/commit/392acc802c0596caaff1c8c72ce1d955863c0b1d)), closes [#223](https://github.com/lutyjj/esp32-streamline/issues/223)
* **tools:** build the smoke admin key without scanner-visible entropy ([00e24dd](https://github.com/lutyjj/esp32-streamline/commit/00e24dd5201f0dcc565ebcc29c4bca9e66b74d5b))

## [0.7.2](https://github.com/lutyjj/esp32-streamline/compare/v0.7.1...v0.7.2) (2026-07-17)


### Bug Fixes

* **ci:** publish from the release commit, not a tag that publish creates ([eadcc5b](https://github.com/lutyjj/esp32-streamline/commit/eadcc5b305d0f1c81c57fa8da6cc9ec1073ed266))
* **ci:** resolve the release commit from the release record alone ([d2d5bf5](https://github.com/lutyjj/esp32-streamline/commit/d2d5bf533de828c432bd985f7f61c86bdc2d7677))
* **ci:** scope release-please write permissions to its job ([4f14ebf](https://github.com/lutyjj/esp32-streamline/commit/4f14ebf86e11efc8c7da054a9c871e5ed0c4ae74))

## [0.7.1](https://github.com/lutyjj/esp32-streamline/compare/v0.7.0...v0.7.1) (2026-07-17)


### Bug Fixes

* **ci:** keep QEMU smoke reruns on the attempt's images ([8c91bba](https://github.com/lutyjj/esp32-streamline/commit/8c91bbade50cad33a28010706fa6060f50ab91ba))

## [0.7.0]

### 🚀 Features
- Build byte-reproducible release images
- Rejoin Wi-Fi on its own after a network outage

### 🐛 Bug Fixes
- Make source and listener lifecycles atomic
- Harden audio calibration and profile contracts

### 📚 Documentation
- Replace leftover em dashes with plain punctuation
- Promise self-heal and a recovery form on AP fallback

## [0.6.2]

### 🚀 Features
- Assign board LED roles from the System tab
- Steer setup clients to console
- Assign roles to board LEDs
- Show device resource health
- Expose device resource telemetry

### 🐛 Bug Fixes
- The A1S status light is active-low
- Report NVS free as writable entries, harden bytes()

### ⚡ Performance
- Right-size the metrics render buffer

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
