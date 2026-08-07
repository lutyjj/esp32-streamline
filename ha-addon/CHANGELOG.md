# Changelog

Notable changes per release, grouped by type.
## [0.12.0](https://github.com/lutyjj/esp32-streamline/compare/v0.11.2...v0.12.0) (2026-08-07)


### ⚠ BREAKING CHANGES

* **firmware:** prove the admin key with digest auth and make the setup password device identity
* **bridge:** require the complete transport state shape
* **bridge:** one API token and console-switched encryption

### Features

* 0.1.0 ([44b10fd](https://github.com/lutyjj/esp32-streamline/commit/44b10fdfe122c37b5ba684c5c1f10770f9fcd5e5))
* add bounded non-interactive serial capture ([cdf6749](https://github.com/lutyjj/esp32-streamline/commit/cdf67493c34296fd49c2d0f9b659840e58826928))
* add local analog output ([4590f9b](https://github.com/lutyjj/esp32-streamline/commit/4590f9bd19f8b81d87bcaf4376b600aceac8cfa8))
* add local analog output ([6e2ae7a](https://github.com/lutyjj/esp32-streamline/commit/6e2ae7ab6e31de78778e68db654c7b40324c5a8c))
* add lossless bridge recordings ([9bad195](https://github.com/lutyjj/esp32-streamline/commit/9bad195ecaa029164efe75c975d8ef4cc373f2e2))
* add secure PCM transport ([379f202](https://github.com/lutyjj/esp32-streamline/commit/379f202ba44192d4d95a166aaeb7085b77c5fdf3))
* add source audio profiles ([#111](https://github.com/lutyjj/esp32-streamline/issues/111)) ([17a5a8c](https://github.com/lutyjj/esp32-streamline/commit/17a5a8c6337ef0ade2935a270a8bd13fe15f5adc))
* add verified OTA firmware updates ([54d7d69](https://github.com/lutyjj/esp32-streamline/commit/54d7d6991514621107f0e16529de41f6a321e5cc))
* add verified OTA firmware updates ([070c80d](https://github.com/lutyjj/esp32-streamline/commit/070c80dac6d388fa353fbc7020253d9e72d6ba45))
* **api:** derive device contract and console client ([#115](https://github.com/lutyjj/esp32-streamline/issues/115)) ([6d4e4bf](https://github.com/lutyjj/esp32-streamline/commit/6d4e4bf81585b0d71baf83865c47af0b8b7cffee))
* authenticate mutating HTTP API with a console secret ([#13](https://github.com/lutyjj/esp32-streamline/issues/13)) ([34bc4c4](https://github.com/lutyjj/esp32-streamline/commit/34bc4c46e3c71c448d0ea0b6443b8adc6ace9ee1))
* board descriptor drives capabilities, validation, and the console ([#79](https://github.com/lutyjj/esp32-streamline/issues/79)) ([1ce54d4](https://github.com/lutyjj/esp32-streamline/commit/1ce54d465166fe269c022e9cf19b437888ee80dd))
* bounded non-interactive serial capture ([6f70e12](https://github.com/lutyjj/esp32-streamline/commit/6f70e1200e40f88c952d6c6b1a4dfb90acf567e3))
* **bridge:** add live source console ([436284b](https://github.com/lutyjj/esp32-streamline/commit/436284b11727814dfb1390040113e9c2203d09ec))
* **bridge:** add lossless recording core ([847a2f7](https://github.com/lutyjj/esp32-streamline/commit/847a2f7922ce59d5b43898a118dc7f93109854b5))
* **bridge:** add recording workspace ([e40ac72](https://github.com/lutyjj/esp32-streamline/commit/e40ac72976ad393910ecf099acb163cc67ef4c12))
* **bridge:** authenticate PCM with TLS 1.3 PSK ([07c2eb5](https://github.com/lutyjj/esp32-streamline/commit/07c2eb521345a45bcdf3a7e37c13d89f34db89af))
* **bridge:** expose recording API ([4c9c694](https://github.com/lutyjj/esp32-streamline/commit/4c9c6946e0c061abbb2597fcf57870b63de68f88))
* **bridge:** log source connect/disconnect via the logging module ([7fa7e5a](https://github.com/lutyjj/esp32-streamline/commit/7fa7e5a7f0795bb18e7d0746da6909f83b4218d3))
* **bridge:** one API token and console-switched encryption ([11fa418](https://github.com/lutyjj/esp32-streamline/commit/11fa4188b31cd2ddc181edf701ad2c1550ee013e))
* **bridge:** support multiple TCP producers ([#41](https://github.com/lutyjj/esp32-streamline/issues/41)) ([c67612e](https://github.com/lutyjj/esp32-streamline/commit/c67612e19af1cb5bf9d3a41012edd3ee38b19282))
* CI-run QEMU device smoke, lifecycle coverage, and a navigable tools library ([df4b860](https://github.com/lutyjj/esp32-streamline/commit/df4b8608df583af124bd0fe7e3d16ee9a0179de0))
* **console:** add theme preference ([8a3bfad](https://github.com/lutyjj/esp32-streamline/commit/8a3bfad4e35e60cc70ab707ab89a6ab29ac261ab))
* **console:** add theme preference ([a9a9fe4](https://github.com/lutyjj/esp32-streamline/commit/a9a9fe412546f6aa7a659ab5824490b552e09fc6))
* **console:** assign board LED roles from the System tab ([654f960](https://github.com/lutyjj/esp32-streamline/commit/654f96013ef9c64ddf52a28dcb1eaa48f15cbe8c))
* **console:** button action assignment and paused-streaming recovery ([e7aaa10](https://github.com/lutyjj/esp32-streamline/commit/e7aaa1014a312afcebef12d5238884aba96f08f8))
* **console:** flows as data, and an input guide that owns passthrough ([f7bc2d0](https://github.com/lutyjj/esp32-streamline/commit/f7bc2d0e58a3064b04d7a9e3900cfed6372a456d))
* **console:** guide encryption setup in the shared wizard sheet ([ce787d2](https://github.com/lutyjj/esp32-streamline/commit/ce787d2dbcf5efc539b0f67f8da2eaeb99950388))
* **console:** guide the whole bridge hookup with a setup wizard ([ac3e1e9](https://github.com/lutyjj/esp32-streamline/commit/ac3e1e966ec8945226f904ad2029281e4ce3b836))
* **console:** guide the whole bridge hookup with a setup wizard ([d0db257](https://github.com/lutyjj/esp32-streamline/commit/d0db2577ba2f799046c764110478914c9fc29a0f))
* **console:** let a parent control a Disclosure ([8157da7](https://github.com/lutyjj/esp32-streamline/commit/8157da74e6bf4b27de0ab6c4aee85f265e01bec4))
* **console:** manage secure PCM transport ([55af0f7](https://github.com/lutyjj/esp32-streamline/commit/55af0f781bf9a48380a1e5bc80cd73fa8342a4e6))
* **console:** one bridge lock, guided encryption, and a Toggle primitive ([6a3ee4d](https://github.com/lutyjj/esp32-streamline/commit/6a3ee4d6945e59cf9f0143676a354b2aab90a60f))
* **console:** Playwright journey specs against the mock backends ([89fead1](https://github.com/lutyjj/esp32-streamline/commit/89fead11f2c054a2138a78b96694da3c77f2bcc0))
* **console:** raise a critical callout while audio is dropping ([9497752](https://github.com/lutyjj/esp32-streamline/commit/94977525412624749ef051ed0d9d030ecfcac8c8))
* **console:** read the device log from System ([7007672](https://github.com/lutyjj/esp32-streamline/commit/7007672a2fb95839cab64df3473b702caedf0c89))
* **console:** rebuild the web console on one design system ([#54](https://github.com/lutyjj/esp32-streamline/issues/54)) ([20beee8](https://github.com/lutyjj/esp32-streamline/commit/20beee8d2236c6d1321b51706c9ea5de1c1c1d0b))
* **console:** reimplement console component ([f3b99a1](https://github.com/lutyjj/esp32-streamline/commit/f3b99a1066f6f77684610f764105de4498670cf3))
* **console:** show device resource health ([697634e](https://github.com/lutyjj/esp32-streamline/commit/697634e718fe3b0e05550ac66d16862c1c3641e1))
* **console:** stateful mock backends for both consoles ([97754e4](https://github.com/lutyjj/esp32-streamline/commit/97754e4584a09ca796ba7365863b4acb2d63ba1e))
* **console:** unify navigation and design system ([a399877](https://github.com/lutyjj/esp32-streamline/commit/a3998776f00220927dd79ca9c2314cec9b0566be))
* **console:** unify navigation and design system ([5e6e1e4](https://github.com/lutyjj/esp32-streamline/commit/5e6e1e42fbf4113b3facb8d4465b0990ea50dc48))
* drive audio pins from board descriptors ([#81](https://github.com/lutyjj/esp32-streamline/issues/81)) ([615a38c](https://github.com/lutyjj/esp32-streamline/commit/615a38cd516eedc0641f2d8bc9b6abb317346429))
* expose firmware prometheus metrics ([fb91583](https://github.com/lutyjj/esp32-streamline/commit/fb91583a6c2d745bae214ef9639bfa4529786740))
* **firmware:** add automatic update schedules ([#98](https://github.com/lutyjj/esp32-streamline/issues/98)) ([5dce363](https://github.com/lutyjj/esp32-streamline/commit/5dce363d66d88e0efd49c22908fdcd0e0965116c))
* **firmware:** add QEMU image variant with emulated ethernet ([b5fb22d](https://github.com/lutyjj/esp32-streamline/commit/b5fb22d364429073858d050a6c65f3c4a5e01de8))
* **firmware:** add silence detection to stop idle streaming ([#23](https://github.com/lutyjj/esp32-streamline/issues/23)) ([4d1914d](https://github.com/lutyjj/esp32-streamline/commit/4d1914d5fff90fd6ba625768e229809a355578c2))
* **firmware:** add status light ([#114](https://github.com/lutyjj/esp32-streamline/issues/114)) ([1b4d01d](https://github.com/lutyjj/esp32-streamline/commit/1b4d01d1c542c6daa178180577ad75e31d396fd4))
* **firmware:** adopt 4 MB flash partition layout ([#90](https://github.com/lutyjj/esp32-streamline/issues/90)) ([f3d4222](https://github.com/lutyjj/esp32-streamline/commit/f3d42227be6e9d46168242cc8c23ab63358607f2))
* **firmware:** advertise console over mdns ([#65](https://github.com/lutyjj/esp32-streamline/issues/65)) ([39ed036](https://github.com/lutyjj/esp32-streamline/commit/39ed036aab594c37de10d637689b0e2284afd243))
* **firmware:** apply audio settings without rebooting ([#59](https://github.com/lutyjj/esp32-streamline/issues/59)) ([5d52ae2](https://github.com/lutyjj/esp32-streamline/commit/5d52ae2f6257840ea2f25a25c0e8b53e04b1add5)), closes [#55](https://github.com/lutyjj/esp32-streamline/issues/55)
* **firmware:** assign roles to board LEDs ([7818975](https://github.com/lutyjj/esp32-streamline/commit/78189757415168e199b8643ceeac272c5558270e))
* **firmware:** assignable button actions and streaming pause ([9db8ba2](https://github.com/lutyjj/esp32-streamline/commit/9db8ba29e57e462bb1bf3990fd72ac783d981e89))
* **firmware:** build byte-reproducible release images ([7882099](https://github.com/lutyjj/esp32-streamline/commit/78820996e7de9c22ce555a321723b99e8c96fae1))
* **firmware:** capture a panic's core dump and serve it over the API ([c9554d4](https://github.com/lutyjj/esp32-streamline/commit/c9554d48592098ecb500c0eb56c1262a590bbaa1))
* **firmware:** carry the canonical example device in the contract ([952057d](https://github.com/lutyjj/esp32-streamline/commit/952057de135220fb89decdc370ba89fd2b9a1c2a))
* **firmware:** configurable device name ([#60](https://github.com/lutyjj/esp32-streamline/issues/60)) ([5679601](https://github.com/lutyjj/esp32-streamline/commit/567960163760ac3eb542bcac3c7cd07758cd2b6e)), closes [#56](https://github.com/lutyjj/esp32-streamline/issues/56)
* **firmware:** count and log send stalls ([e058ec4](https://github.com/lutyjj/esp32-streamline/commit/e058ec405fa0dcad3ef9903eb2039274308da97a))
* **firmware:** drive boards from JSON descriptors with custom upload ([#83](https://github.com/lutyjj/esp32-streamline/issues/83)) ([b1dc800](https://github.com/lutyjj/esp32-streamline/commit/b1dc800913c72bccad41f069d8779317203bbde1))
* **firmware:** expose device resource telemetry ([2bd7670](https://github.com/lutyjj/esp32-streamline/commit/2bd767033f44d3ee92ad879d44e8a669fed39d3f))
* **firmware:** gain and attenuation step actions ([cb62faf](https://github.com/lutyjj/esp32-streamline/commit/cb62faf44b1c9b6866989481e93f1f6a49186d7f))
* **firmware:** generate admin key during setup ([#26](https://github.com/lutyjj/esp32-streamline/issues/26)) ([773c23d](https://github.com/lutyjj/esp32-streamline/commit/773c23d93abcc75aeb456c06f51a1d52bb92fa57))
* **firmware:** install pinned custom images over the air ([5adfe06](https://github.com/lutyjj/esp32-streamline/commit/5adfe06225d1d58567b231ccce9b915ef4800367))
* **firmware:** open the setup AP for one boot when a button is held at power-on ([ef4fcba](https://github.com/lutyjj/esp32-streamline/commit/ef4fcba71f0934b64c76407b5605784d2a527b99))
* **firmware:** protect the setup AP with a per-device WPA2 password ([32f5910](https://github.com/lutyjj/esp32-streamline/commit/32f5910a9f5ec16e725e59ec1f824ee30094043e))
* **firmware:** prove the admin key with digest auth and make the setup password device identity ([d58ed51](https://github.com/lutyjj/esp32-streamline/commit/d58ed5120913e4433785bc25e9d02efb5a6a18f2))
* **firmware:** rejoin Wi-Fi on its own after a network outage ([1550c70](https://github.com/lutyjj/esp32-streamline/commit/1550c70cb2619c6dd7b71f9f2b1ba91bd12bf9cf))
* **firmware:** report OTA signature enforcement and name rejections ([167b63d](https://github.com/lutyjj/esp32-streamline/commit/167b63d95add1c2b56a3873426464a91b70cefe3))
* **firmware:** report secure transport failures ([e271c82](https://github.com/lutyjj/esp32-streamline/commit/e271c820b823a9b6aa6956f0bae92dc70aa47c2a))
* **firmware:** secure PCM transport with per-device keys ([1e54358](https://github.com/lutyjj/esp32-streamline/commit/1e54358f889c2b06ebc5eb351142ebd71420a3cd))
* **firmware:** serve the device log at /api/logs ([d8cd049](https://github.com/lutyjj/esp32-streamline/commit/d8cd049f8705f9cd0c2af4cac6b12f748d5a40b7))
* **firmware:** shrink the OTA image by 192 KB ([bb16232](https://github.com/lutyjj/esp32-streamline/commit/bb162320b10dd250a7dee0ee13291c9dba7e26ab))
* **firmware:** steer setup clients to console ([9abefc5](https://github.com/lutyjj/esp32-streamline/commit/9abefc58c03b77a84ae138dbb0c8f5772eb29de0))
* **firmware:** store the embedded console and OpenAPI artifact gzipped ([5061547](https://github.com/lutyjj/esp32-streamline/commit/5061547f0969e1fbfcee5d80a3c92425a568b522))
* **firmware:** verify vendor RSA-3072 signatures on OTA images ([3c8aef1](https://github.com/lutyjj/esp32-streamline/commit/3c8aef1689ed07d53e4e3d012b2e7d3feda87016))
* **ha-addon:** configure recording storage ([21abadb](https://github.com/lutyjj/esp32-streamline/commit/21abadb5d44b5ef9da794fcc7a624e3626d96b19))
* package bridge as Home Assistant add-on ([#85](https://github.com/lutyjj/esp32-streamline/issues/85)) ([169ab06](https://github.com/lutyjj/esp32-streamline/commit/169ab064c948ac4d293c6e874fc2ba6f21565f4c))
* **protocol:** define TLS 1.3 PCM transport contract ([8c15c34](https://github.com/lutyjj/esp32-streamline/commit/8c15c34de6fdb675ab5cedcaa38a8a60e69c7a11))
* QEMU network smoke — emulated ethernet variant, pytest-embedded suite, reboot-response fix ([6ade922](https://github.com/lutyjj/esp32-streamline/commit/6ade922ca9687622abe0f1d2120f9180d9299ba6))
* resolve board preset at boot ([00d600d](https://github.com/lutyjj/esp32-streamline/commit/00d600d5eba1db58f086f41c297f537ef0ed8958))
* route codec setup through board descriptors ([#80](https://github.com/lutyjj/esp32-streamline/issues/80)) ([ab568a1](https://github.com/lutyjj/esp32-streamline/commit/ab568a175f457677d89b1648ec9ce700f9ff872c))
* separate OTA check from install and redesign the update panel ([#21](https://github.com/lutyjj/esp32-streamline/issues/21)) ([c70867b](https://github.com/lutyjj/esp32-streamline/commit/c70867bca781c54ab3855242aa98889db14e3b92))
* split network settings into wifi and target endpoints ([#89](https://github.com/lutyjj/esp32-streamline/issues/89)) ([6b3ef63](https://github.com/lutyjj/esp32-streamline/commit/6b3ef636a9bee6fcede79be4c970000689f57693))
* **tools:** add boot and API smoke harness for QEMU and USB devices ([6a3895e](https://github.com/lutyjj/esp32-streamline/commit/6a3895eaf7c0c3f8513473e486afafbf4724989a))
* **tools:** attribute firmware flash bytes with make firmware-size-report ([3612722](https://github.com/lutyjj/esp32-streamline/commit/361272238a1c83506bf1890c00d0ac59857216bf))
* **tools:** boot and API smoke harness for QEMU and USB devices ([fcdcedd](https://github.com/lutyjj/esp32-streamline/commit/fcdcedd3b5bafbd8ed7ade641cbb6803e3dadde0))
* **tools:** drive the QEMU smoke through pytest-embedded ([88d1347](https://github.com/lutyjj/esp32-streamline/commit/88d1347947c903f3e4405c8587f6fdeaf9ea0fba))
* **transport:** let owners discard the pending PCM key ([584892a](https://github.com/lutyjj/esp32-streamline/commit/584892aca9afda30ae0c843cf85b3e81d892642d))
* **webflasher:** add browser-based firmware installer ([#24](https://github.com/lutyjj/esp32-streamline/issues/24)) ([9757e1b](https://github.com/lutyjj/esp32-streamline/commit/9757e1b166227ab9c606630b607b54d0ba53854a)), closes [#16](https://github.com/lutyjj/esp32-streamline/issues/16)
* **webflasher:** share the console build ([#95](https://github.com/lutyjj/esp32-streamline/issues/95)) ([60e57d8](https://github.com/lutyjj/esp32-streamline/commit/60e57d8e176f04749307dc6a2f56f24c4f3688b3))
* **web:** guided input-level calibration wizard ([#63](https://github.com/lutyjj/esp32-streamline/issues/63)) ([c183a76](https://github.com/lutyjj/esp32-streamline/commit/c183a7650bc51896474838a228253bd12e9b1cf9))


### Bug Fixes

* add explicit docker.io registry prefix to container images ([#137](https://github.com/lutyjj/esp32-streamline/issues/137)) ([2dbf72f](https://github.com/lutyjj/esp32-streamline/commit/2dbf72f6bc85951bb0d187a71c1bda72dc7a08e0))
* **api:** declare the complete mutation outcome taxonomy per endpoint ([1ab19e7](https://github.com/lutyjj/esp32-streamline/commit/1ab19e7da8f26d9db4f098c300e0ec99e71a482e)), closes [#231](https://github.com/lutyjj/esp32-streamline/issues/231)
* **bridge:** bound HTTP ingress bodies and stalled progress ([#327](https://github.com/lutyjj/esp32-streamline/issues/327)) ([bc4a113](https://github.com/lutyjj/esp32-streamline/commit/bc4a113972a7aed401c8e75e4302d6a20134f1bc))
* **bridge:** close evicted pipelines and bound playout admission ([#326](https://github.com/lutyjj/esp32-streamline/issues/326)) ([3cd0434](https://github.com/lutyjj/esp32-streamline/commit/3cd0434dfd7747c5ad7055525b2d8ec243f6d8d0))
* **bridge:** enforce runtime validation invariants ([e4406fd](https://github.com/lutyjj/esp32-streamline/commit/e4406fd1fb647073d5a48d9eb9a139b122222788))
* **bridge:** harden recording writes ([032735b](https://github.com/lutyjj/esp32-streamline/commit/032735b24be9418042f2c1de202a3e903b0d7a18))
* **bridge:** harden source selection and error reporting ([eebf9ec](https://github.com/lutyjj/esp32-streamline/commit/eebf9ec441f11796f3112b72fd9d5f2a5ddb1d47))
* **bridge:** keep recording polling resilient ([ee9d830](https://github.com/lutyjj/esp32-streamline/commit/ee9d830f0f6476d2e1e3221a32dc5aa0e27c18fb))
* **bridge:** keep repeated recording scans current ([a6c293b](https://github.com/lutyjj/esp32-streamline/commit/a6c293bc73f9d0be0a0d603261540ee814b8f801))
* **bridge:** make source and listener lifecycles atomic ([a01b7f4](https://github.com/lutyjj/esp32-streamline/commit/a01b7f44affb5573b336f01fef9a8faf30d194e5))
* **bridge:** rebuild the recordings console and serve it through HA ingress ([a6dd224](https://github.com/lutyjj/esp32-streamline/commit/a6dd224de9ba133b05c7e43524cdd16fe292734f)), closes [#160](https://github.com/lutyjj/esp32-streamline/issues/160)
* **bridge:** reject exposed transport state files ([#322](https://github.com/lutyjj/esp32-streamline/issues/322)) ([7c18517](https://github.com/lutyjj/esp32-streamline/commit/7c1851747cbac7956e4a4f69179e9b91e26b5064))
* **bridge:** revoke live TLS sessions on transport key mutation ([#328](https://github.com/lutyjj/esp32-streamline/issues/328)) ([b4f9aaa](https://github.com/lutyjj/esp32-streamline/commit/b4f9aaa21ea14235300b326fd7cb0f148673a409))
* **bridge:** secure host-facing boundaries ([009997d](https://github.com/lutyjj/esp32-streamline/commit/009997da539ce91af3d0b0b6e1b0d0f69f00992b))
* **ci:** fetch full history for release-verify changelog check ([7fabffa](https://github.com/lutyjj/esp32-streamline/commit/7fabffafc3199f13761312aef440b1a6be44a57c))
* **ci:** inherit secrets when release-please chains to publish ([#369](https://github.com/lutyjj/esp32-streamline/issues/369)) ([d0fe186](https://github.com/lutyjj/esp32-streamline/commit/d0fe186255a89865599893f6065f262906f1b081))
* **ci:** keep QEMU smoke reruns on the attempt's images ([8c91bba](https://github.com/lutyjj/esp32-streamline/commit/8c91bbade50cad33a28010706fa6060f50ab91ba))
* **ci:** publish from the release commit, not a tag that publish creates ([eadcc5b](https://github.com/lutyjj/esp32-streamline/commit/eadcc5b305d0f1c81c57fa8da6cc9ec1073ed266))
* **ci:** publish releases only for promoted mainline commits ([#329](https://github.com/lutyjj/esp32-streamline/issues/329)) ([3a92050](https://github.com/lutyjj/esp32-streamline/commit/3a92050568933591be300da422887a7c871f881e))
* **ci:** resolve the release commit from the release record alone ([d2d5bf5](https://github.com/lutyjj/esp32-streamline/commit/d2d5bf533de828c432bd985f7f61c86bdc2d7677))
* **ci:** scope release-please write permissions to its job ([4f14ebf](https://github.com/lutyjj/esp32-streamline/commit/4f14ebf86e11efc8c7da054a9c871e5ed0c4ae74))
* **console:** align API endpoint descriptions ([#141](https://github.com/lutyjj/esp32-streamline/issues/141)) ([6b933ca](https://github.com/lutyjj/esp32-streamline/commit/6b933cae555862816e9e1064db2b446fddce565a))
* **console:** arm reboot waits after acknowledgement ([#140](https://github.com/lutyjj/esp32-streamline/issues/140)) ([c54747c](https://github.com/lutyjj/esp32-streamline/commit/c54747c33227709f32d20564005c5d26f03ddbdb))
* **console:** bridge polling died after one tick; one input meter ([d7bc497](https://github.com/lutyjj/esp32-streamline/commit/d7bc49745c021bd64fe73709f52d1f4165afb748))
* **console:** carry modal, announcement, and control semantics in the primitives ([d2ce3f0](https://github.com/lutyjj/esp32-streamline/commit/d2ce3f0ce89d4b3dfb7302c725fd03f8fffb3d69))
* **console:** centralize bridge authorization at the contract boundary ([b97cb8f](https://github.com/lutyjj/esp32-streamline/commit/b97cb8f7cb4c20a4e44a611c2f37509d553d8f59))
* **console:** close the guided-setup seams from the second test round ([3155f5e](https://github.com/lutyjj/esp32-streamline/commit/3155f5e5da6182976424da9578e30929d87432bd))
* **console:** consistent Encryption section, unblocked reboot wait, lock gating ([61f19e2](https://github.com/lutyjj/esp32-streamline/commit/61f19e24f031798065d80ad80de1becd03c41e87))
* **console:** don't report an OTA rollback before the device reboots ([#94](https://github.com/lutyjj/esp32-streamline/issues/94)) ([0ad67c2](https://github.com/lutyjj/esp32-streamline/commit/0ad67c2c33d5fef3b4b61fa3550388b6add3f196)), closes [#92](https://github.com/lutyjj/esp32-streamline/issues/92)
* **console:** end open disclosures at intrinsic height ([d4d6f3f](https://github.com/lutyjj/esp32-streamline/commit/d4d6f3f0b518d8f2bb8debf0d0f004c85116ea92))
* **console:** follow live device audio in the Audio tab controls ([8d22893](https://github.com/lutyjj/esp32-streamline/commit/8d2289346d70551d07e3a9dbcd7e4cce2533b72a))
* **console:** generate curl examples that authenticate and stay contract-true ([c022baa](https://github.com/lutyjj/esp32-streamline/commit/c022baadc5e83c1736340e0a2e99eb14cc940a44))
* **console:** give the New recording form a full-width action row ([e50f855](https://github.com/lutyjj/esp32-streamline/commit/e50f855edacaba80dde2a152741447f86005e035))
* **console:** harden audio calibration and profile contracts ([571b4ce](https://github.com/lutyjj/esp32-streamline/commit/571b4ce46765a1fd3a55b91b8fff893ae3b84435))
* **console:** integrate secure transport with design system ([8540b84](https://github.com/lutyjj/esp32-streamline/commit/8540b84f8b15427c3e9dd19755e03ebb2e661a02))
* **console:** keep action rows with their section ([7b36533](https://github.com/lutyjj/esp32-streamline/commit/7b365337b36b920b37ebcea67ea26eeeb941c7a4))
* **console:** keep an armed inline confirm where its trigger stood ([66e355c](https://github.com/lutyjj/esp32-streamline/commit/66e355cee7c364a03729e9da9219f8ccdaeccf7d))
* **console:** keep local actions usable when locked and confirm destruction ([b1c37ec](https://github.com/lutyjj/esp32-streamline/commit/b1c37ec5fc9ed85116a556068a48a8be307f1d5b))
* **console:** keep the lint gate silent and e2e-proof ([e3fe7e4](https://github.com/lutyjj/esp32-streamline/commit/e3fe7e40bc2117cdc18b33f69d6b1336603d4fb3))
* **console:** make custom OTA a validated source-aware transaction ([f561118](https://github.com/lutyjj/esp32-streamline/commit/f5611182325d32bb497e00d540943175c12b0c03))
* **console:** make dismissing the one-time PSK reveal unmistakable ([1c4558f](https://github.com/lutyjj/esp32-streamline/commit/1c4558f87cd157eb1b2950198707ff42448e1dee))
* **console:** make log text readable in the default theme ([4f01cd6](https://github.com/lutyjj/esp32-streamline/commit/4f01cd65a50159ef5c084f814fe574856ccb6664))
* **console:** make the clip callout dismissible ([37650f5](https://github.com/lutyjj/esp32-streamline/commit/37650f56ff8161b366b22232c2c2d7b54e6c3c1a))
* **console:** model device settings as a failure-aware resource ([5aa1285](https://github.com/lutyjj/esp32-streamline/commit/5aa1285d8869326c82045553c9a74485753233c7))
* **console:** one honest handoff for the first join ([#78](https://github.com/lutyjj/esp32-streamline/issues/78)) ([442c45e](https://github.com/lutyjj/esp32-streamline/commit/442c45ec1f2d4b13ca6357ffcfbd194f06655f8e))
* **console:** one name for the input meter ([f060b83](https://github.com/lutyjj/esp32-streamline/commit/f060b83adca8befcbe51e52f68c0cb10f9c58b78))
* **console:** polish API contract layout ([#116](https://github.com/lutyjj/esp32-streamline/issues/116)) ([6f8eeab](https://github.com/lutyjj/esp32-streamline/commit/6f8eeab40d8ea968750b88655e1ee26355a17abc))
* **console:** polish masthead controls and bridge recording UI ([cef06cf](https://github.com/lutyjj/esp32-streamline/commit/cef06cf7d58bce92b6e4de7f0fc9a533174aaf3f))
* **console:** preserve the upstream dependency contract ([8bfdab3](https://github.com/lutyjj/esp32-streamline/commit/8bfdab3bc291a467e67fcb3e0585fc9571b3d82a))
* **console:** put storage and clipboard behind failure-aware custody ([1feb7d0](https://github.com/lutyjj/esp32-streamline/commit/1feb7d08a2568f51b2856d952c27fa35888a9e70))
* **console:** register the stale-drop counter in the metrics fixture ([f0cf115](https://github.com/lutyjj/esp32-streamline/commit/f0cf1153ea3d1af979460076530a44ff1d824c55))
* **console:** render the recording contract with explicit resource states ([fb978e4](https://github.com/lutyjj/esp32-streamline/commit/fb978e41138cd756d4c17247da8ab12bda9086f7))
* **console:** report NVS free as writable entries, harden bytes() ([b7d67c1](https://github.com/lutyjj/esp32-streamline/commit/b7d67c1dffdb31100fac5ffbb096ad646a42e905))
* **console:** show the firmware version with a live status dot ([9e86764](https://github.com/lutyjj/esp32-streamline/commit/9e867644c3769102afd9e8989a435d7637904e41)), closes [#160](https://github.com/lutyjj/esp32-streamline/issues/160)
* **console:** snapshot audio profiles from live status, not stale settings ([4d76248](https://github.com/lutyjj/esp32-streamline/commit/4d76248c21998d1b288231bcaf19234206597d9a))
* **console:** stop the browser prompting for credentials on unlock ([0389158](https://github.com/lutyjj/esp32-streamline/commit/038915808f1666724f8c317c12c0fa2abc524650))
* **console:** treat factory reset as a setup-network handoff ([6805859](https://github.com/lutyjj/esp32-streamline/commit/6805859d444463c230c31b07a328abae2e7da709))
* **firmware:** bound in-flight packet retry to the queue's latency budget ([b79cebb](https://github.com/lutyjj/esp32-streamline/commit/b79cebb0c6d99c0987f4a0948a6441b6257eef96)), closes [#224](https://github.com/lutyjj/esp32-streamline/issues/224)
* **firmware:** calibrate play detection to the tracked idle level ([#53](https://github.com/lutyjj/esp32-streamline/issues/53)) ([3795088](https://github.com/lutyjj/esp32-streamline/commit/3795088886dbc55d2dea80e7b3d550e8b7d5e1fe)), closes [#51](https://github.com/lutyjj/esp32-streamline/issues/51)
* **firmware:** complete reboot responses before restarting ([b0b53c8](https://github.com/lutyjj/esp32-streamline/commit/b0b53c80bf7ab25a201694f3ab84aaeb6c64cfbd))
* **firmware:** cut over when activating transport key ([c163eeb](https://github.com/lutyjj/esp32-streamline/commit/c163eeb66301a8823989cdff7754776f057ee098))
* **firmware:** declare and smoke rollback conflict as 409 ([2be18f7](https://github.com/lutyjj/esp32-streamline/commit/2be18f77aab4889d3684caf6ca957d2ead20ea69))
* **firmware:** disable Nagle on the TLS PCM socket and keep the radio awake ([069f0b9](https://github.com/lutyjj/esp32-streamline/commit/069f0b96d80f10286cd8eb3e039fb834bcd1658f))
* **firmware:** drop the storage layout that predates generations ([c9d1200](https://github.com/lutyjj/esp32-streamline/commit/c9d12000a57c41ba8842b2fad28f5fa88bc7bbd0))
* **firmware:** enforce the secure TLS profile ([69c1d6d](https://github.com/lutyjj/esp32-streamline/commit/69c1d6d81b463478a470ddae088ede206028228a))
* **firmware:** expire playback and account the timeline through capture stalls ([8e5edee](https://github.com/lutyjj/esp32-streamline/commit/8e5edeedc6567f3b7b818d3ae162bf18c6677a97)), closes [#225](https://github.com/lutyjj/esp32-streamline/issues/225)
* **firmware:** give setup-mode settings writes one policy ([0d1c0ff](https://github.com/lutyjj/esp32-streamline/commit/0d1c0ff574541949cfa676ab5f441ee305b20b4e))
* **firmware:** hold one TLS receive buffer for the whole OTA download ([741ca6a](https://github.com/lutyjj/esp32-streamline/commit/741ca6a449b21a1c8fa394f79c1f791996d1d747)), closes [#373](https://github.com/lutyjj/esp32-streamline/issues/373)
* **firmware:** keep button-press stacks off the OTA check's heap margin ([6a4693e](https://github.com/lutyjj/esp32-streamline/commit/6a4693ebe9483561aa6b78f0415647e048386cb3))
* **firmware:** keep OTA partition table when flashing over serial ([#50](https://github.com/lutyjj/esp32-streamline/issues/50)) ([7d8204f](https://github.com/lutyjj/esp32-streamline/commit/7d8204fd706ef70559205d39ce65fa5e3b74f3f8))
* **firmware:** keep the audio pipeline above httpd in task priority ([cb76274](https://github.com/lutyjj/esp32-streamline/commit/cb76274b69a4d9ad5c87f381dfecd811840c381c))
* **firmware:** make board state recovery-safe ([740d51e](https://github.com/lutyjj/esp32-streamline/commit/740d51e0e50e90ba9b2943026f46f173c1afc34a))
* **firmware:** make board state recovery-safe ([f731598](https://github.com/lutyjj/esp32-streamline/commit/f7315981c16582f9bc7660ea2f58310fda1434cd))
* **firmware:** make OTA start atomic and tolerate junk in SHA256SUMS ([208d819](https://github.com/lutyjj/esp32-streamline/commit/208d819096f6dbf35a22f50d100771aad967cb02))
* **firmware:** make the OTA quiesce handshake explicit and stop regenerating the setup password on a read error ([799a0ed](https://github.com/lutyjj/esp32-streamline/commit/799a0ede8d11be92c928130419513c19ea0b3b8e))
* **firmware:** make the OTA quiesce handshake explicit; stop regenerating the setup password on a read error ([#370](https://github.com/lutyjj/esp32-streamline/issues/370)) ([799a0ed](https://github.com/lutyjj/esp32-streamline/commit/799a0ede8d11be92c928130419513c19ea0b3b8e))
* **firmware:** match esp-tls error records as they are captured ([20cc139](https://github.com/lutyjj/esp32-streamline/commit/20cc1391be6e92dec7d9678eaf5a0f39191426a8))
* **firmware:** name the real cause of a failed TLS connection ([cda2187](https://github.com/lutyjj/esp32-streamline/commit/cda2187d69cf69626e249b0bf240a0fc4fddc658))
* **firmware:** open setup when stored state cannot be decoded ([cc26f11](https://github.com/lutyjj/esp32-streamline/commit/cc26f11d5f3cde3d85adf21a487b9e8fb3452703))
* **firmware:** package the two-slot OTA table in the full image ([824790f](https://github.com/lutyjj/esp32-streamline/commit/824790ffdd88c4a15b9d9fc6b06d0e5a48e5dff3))
* **firmware:** pause streaming during an OTA install so it cannot panic ([#366](https://github.com/lutyjj/esp32-streamline/issues/366)) ([62a2bb5](https://github.com/lutyjj/esp32-streamline/commit/62a2bb51b510066d13d17d791601170a9330f8af)), closes [#335](https://github.com/lutyjj/esp32-streamline/issues/335)
* **firmware:** report console readiness only once the API can answer ([b1b0647](https://github.com/lutyjj/esp32-streamline/commit/b1b0647aae4460a6665a38ddf1834d04197cfb87))
* **firmware:** require explicit Wi-Fi password changes ([52b132c](https://github.com/lutyjj/esp32-streamline/commit/52b132c92db80b5c83c480e73a911da2db8b86bd))
* **firmware:** rewrite play detection with amplitude and time hysteresis ([26343fd](https://github.com/lutyjj/esp32-streamline/commit/26343fde0bb03c735b7d3afc00b0ed3934e1abc7))
* **firmware:** size HTTP stack for key writes ([56a02a5](https://github.com/lutyjj/esp32-streamline/commit/56a02a5b1e3eabcaab1232d2493ff4013d6f253a))
* **firmware:** stop status reads from spinning the stream counters ([006bc51](https://github.com/lutyjj/esp32-streamline/commit/006bc515dce8d9b2ee70e261de69e2707baf77b3))
* **firmware:** stream HTTP bodies instead of materializing them ([3e83359](https://github.com/lutyjj/esp32-streamline/commit/3e83359bbc96c4e0f3ec304ad10a43c53556ddf7))
* **firmware:** the A1S status light is active-low ([e59d059](https://github.com/lutyjj/esp32-streamline/commit/e59d059046a8ea09a73212fd5e2adac5f713c568))
* **firmware:** treat the log hook as a stream, not a line at a time ([07eeaec](https://github.com/lutyjj/esp32-streamline/commit/07eeaec7413ed3bfa99f48419ccffac7ab1beec0))
* **firmware:** use dynamic mbedTLS buffers so the update check survives streaming ([36bff18](https://github.com/lutyjj/esp32-streamline/commit/36bff188d5ac48d2910f383be9af1f0d2143a491)), closes [#334](https://github.com/lutyjj/esp32-streamline/issues/334)
* **firmware:** validate admin keys against one exact generated shape ([21106ff](https://github.com/lutyjj/esp32-streamline/commit/21106ffcef054891dcf99ee403ed57778de45146)), closes [#229](https://github.com/lutyjj/esp32-streamline/issues/229)
* **firmware:** verify unlock keys and harden the OTA flow ([ee9e853](https://github.com/lutyjj/esp32-streamline/commit/ee9e8530d505e52c60fba9f58a78ac63d4b0efd1))
* **firmware:** void a pending verification when the stream target changes ([bbcaa87](https://github.com/lutyjj/esp32-streamline/commit/bbcaa87296da5bf8fa8b4608e0d2d156d2d80ebf))
* **ha-addon:** enforce generated changelog ([#117](https://github.com/lutyjj/esp32-streamline/issues/117)) ([aac01c4](https://github.com/lutyjj/esp32-streamline/commit/aac01c4e3aaf4bf0c6a46f4a29e9d161156ad64f))
* **ha-addon:** keep recordings out of backups ([c1192c8](https://github.com/lutyjj/esp32-streamline/commit/c1192c8b8cdb62bdeb79949900cfe58df04fe853))
* identify the boot a log line belongs to ([1a142ad](https://github.com/lutyjj/esp32-streamline/commit/1a142ad481cca92afa7cbc5dc7eafb8b4deadf74))
* keep Home Assistant recordings out of backups ([bf3899d](https://github.com/lutyjj/esp32-streamline/commit/bf3899d5b38f64354184039743dc624ba362bcb9))
* make transport encryption usable end to end ([d78a967](https://github.com/lutyjj/esp32-streamline/commit/d78a96737a529682e7204326dbf404d33754ea7c))
* **ota:** keep custom image URLs out of diagnostics ([#325](https://github.com/lutyjj/esp32-streamline/issues/325)) ([958348b](https://github.com/lutyjj/esp32-streamline/commit/958348b526ec11bad98a0ef7f83ddf57b1dc9906))
* patch OTA process to actually get it working ([258e80c](https://github.com/lutyjj/esp32-streamline/commit/258e80c8a5798fc437cf972e18738ff5f1eac134))
* **protocol:** coalesce short capture reads into fixed 256-frame packets ([392acc8](https://github.com/lutyjj/esp32-streamline/commit/392acc802c0596caaff1c8c72ce1d955863c0b1d)), closes [#223](https://github.com/lutyjj/esp32-streamline/issues/223)
* publish one-file firmware release image ([#2](https://github.com/lutyjj/esp32-streamline/issues/2)) ([b09bdb5](https://github.com/lutyjj/esp32-streamline/commit/b09bdb5316637fd2ce6ed8fce799b7a891fef848))
* **release:** commit generated bridge lock ([dd561f7](https://github.com/lutyjj/esp32-streamline/commit/dd561f77e061edeb71c92a32ebc18bb56569ed54))
* **release:** commit generated bridge lock ([6e293ca](https://github.com/lutyjj/esp32-streamline/commit/6e293cad665a93049003ac95d6147534fa840c91))
* **release:** keep the tools-image build echo out of release notes ([1697065](https://github.com/lutyjj/esp32-streamline/commit/16970655b91cf2f6d6dc39261b98601179c84a56))
* **release:** keep the tools-image build echo out of release notes ([5145192](https://github.com/lutyjj/esp32-streamline/commit/5145192d803f07f9c03a15f924b1b16ce96bd352))
* **release:** keep versioned locks synchronized ([e8cbbf0](https://github.com/lutyjj/esp32-streamline/commit/e8cbbf0752893b423be12d3bd96f5b924ded08c9))
* **release:** keep versioned locks synchronized ([07ea812](https://github.com/lutyjj/esp32-streamline/commit/07ea8126efbd019e88d3fe7e4d433ea898bf5163))
* **release:** make changelog history deterministic ([491fd18](https://github.com/lutyjj/esp32-streamline/commit/491fd181d3e698874555983179eca8c575aed50d))
* **release:** make changelog snapshots reproducible ([cfb3e51](https://github.com/lutyjj/esp32-streamline/commit/cfb3e51c102610e361c167f9f5c2e09647b9726b))
* **release:** make changelog snapshots reproducible ([eae2131](https://github.com/lutyjj/esp32-streamline/commit/eae2131019791fb0b8ab5fa5f479aad299a3e605))
* **release:** prune stale changelog tags ([8f6f204](https://github.com/lutyjj/esp32-streamline/commit/8f6f2049a85ff8df2d6fd00bdf16c83bc2288f98))
* **release:** set release title explicitly ([0c04e6c](https://github.com/lutyjj/esp32-streamline/commit/0c04e6c68c7de7fceae2f576db955e27e2c275ac))
* **release:** set release title explicitly ([f81c232](https://github.com/lutyjj/esp32-streamline/commit/f81c23286c219f15dccbc49dc02c6dce76a848dd))
* resolve OTA update issues with SNTP sync and GitHub redirects ([6306ab2](https://github.com/lutyjj/esp32-streamline/commit/6306ab2e20fbf56c8f2699e74e0c0f1682a94cec))
* run HA add-on with Supervisor data access ([ab5685c](https://github.com/lutyjj/esp32-streamline/commit/ab5685cfbf91d90c40c2506842cd62a11ee2d3e9))
* **tools:** build the smoke admin key without scanner-visible entropy ([00e24dd](https://github.com/lutyjj/esp32-streamline/commit/00e24dd5201f0dcc565ebcc29c4bca9e66b74d5b))
* **tools:** keep device credentials off process metadata ([#323](https://github.com/lutyjj/esp32-streamline/issues/323)) ([ef409bd](https://github.com/lutyjj/esp32-streamline/commit/ef409bdfbc3f5302c0808a764eae8f0202aae435))
* **tools:** keep pytest away from the admin-key descriptor in smoke-device ([29d4b14](https://github.com/lutyjj/esp32-streamline/commit/29d4b14e0037991959c6ed195cfb754bb9390d7e))
* unify the bridge and device consoles, serve the bridge console via HA ingress ([3392c56](https://github.com/lutyjj/esp32-streamline/commit/3392c56ac29be0c7b228a7e0e2e8c2a5575d5b89))
* **webflasher:** correct browser support and clean-install copy ([65fe14f](https://github.com/lutyjj/esp32-streamline/commit/65fe14f23f8143bfea87f01ea5483e83fb19a43b))
* **webflasher:** serve manifest during development ([#97](https://github.com/lutyjj/esp32-streamline/issues/97)) ([bf4923a](https://github.com/lutyjj/esp32-streamline/commit/bf4923a97d5771d3f0dd888c8207fe043b9b1dfe))
* **web:** gate locked console controls generically ([#64](https://github.com/lutyjj/esp32-streamline/issues/64)) ([30be946](https://github.com/lutyjj/esp32-streamline/commit/30be9468d88260c5e504d29eee26a1734c117fcd))


### Performance Improvements

* **firmware:** read rollback availability once at boot ([c23f59c](https://github.com/lutyjj/esp32-streamline/commit/c23f59c4be6d3735decbd6cb44fd995d3ecf11d1))
* **firmware:** right-size the metrics render buffer ([f56433c](https://github.com/lutyjj/esp32-streamline/commit/f56433c6b3d076e758bc997bd985350662657c68))
* **tools:** run the QEMU smoke suite in parallel with SMOKE_JOBS ([08524a1](https://github.com/lutyjj/esp32-streamline/commit/08524a12022b48f1c41fbf2b806d76f02e119cfe))


### Code Refactoring

* **bridge:** require the complete transport state shape ([99dc444](https://github.com/lutyjj/esp32-streamline/commit/99dc444e77b359eed5d1516805ea1c1870f207c2))

## [0.11.2](https://github.com/lutyjj/esp32-streamline/compare/v0.11.1...v0.11.2) (2026-08-07)


### Bug Fixes

* **console:** keep the lint gate silent and e2e-proof ([e3fe7e4](https://github.com/lutyjj/esp32-streamline/commit/e3fe7e40bc2117cdc18b33f69d6b1336603d4fb3))
* **firmware:** drop the storage layout that predates generations ([c9d1200](https://github.com/lutyjj/esp32-streamline/commit/c9d12000a57c41ba8842b2fad28f5fa88bc7bbd0))
* **firmware:** give setup-mode settings writes one policy ([0d1c0ff](https://github.com/lutyjj/esp32-streamline/commit/0d1c0ff574541949cfa676ab5f441ee305b20b4e))
* **firmware:** open setup when stored state cannot be decoded ([cc26f11](https://github.com/lutyjj/esp32-streamline/commit/cc26f11d5f3cde3d85adf21a487b9e8fb3452703))
* **firmware:** report console readiness only once the API can answer ([b1b0647](https://github.com/lutyjj/esp32-streamline/commit/b1b0647aae4460a6665a38ddf1834d04197cfb87))

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
