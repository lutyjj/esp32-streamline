include ../mk/common.mk

IMAGE := esp32-streamline-firmware
SRC := streamline
TARGET := xtensa-esp32-espidf
ELF := target/$(TARGET)/release/streamline-firmware
VERSION ?= dev
PORT ?= /dev/cu.usbserial-0001
# Flash size baked into the release images. Keep in step with
# CONFIG_ESPTOOLPY_FLASHSIZE in streamline/sdkconfig.defaults, which sizes the
# bootloader for the same chip. espflash wants it lowercase, esptool uppercase.
FLASH_SIZE ?= 4mb
FLASH_SIZE_UPPER := $(shell echo $(FLASH_SIZE) | tr a-z A-Z)
# RSA-3072 key that signs the application image so the device accepts it (the
# firmware enforces vendor signatures — CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT).
# Dev and QEMU builds use the committed public throwaway key, which gives
# integrity, not authenticity; release CI overrides this with the maintainer's
# secret key. Evaluated inside the container, whose workdir is firmware/streamline.
SIGNING_KEY ?= dev_signing_key.pem
DIST_DIR ?= $(abspath ../dist)
# macOS ships shasum, minimal Linux hosts only sha256sum; both print the same
# "hash  filename" lines SHA256SUMS consumers expect.
SHA256 := $(shell command -v shasum >/dev/null 2>&1 && echo "shasum -a 256" || echo sha256sum)
ROOT_DIR := $(abspath ..)
CONSOLE_DIR := $(ROOT_DIR)/console
CONTAINER_WORKSPACE := /repo
CONTAINER_USER ?= 0:0
CONTAINER_HOME ?= /home/esp
CONTAINER_GIT_SAFE_DIR ?= $(CONTAINER_WORKSPACE)
CONTAINER_CARGO_HOME ?=
CONTAINER_EXTRA_FLAGS ?=
CONTAINER_CARGO_ENV := $(if $(CONTAINER_CARGO_HOME),-e CARGO_HOME="$(CONTAINER_CARGO_HOME)")

# Firmware uses Espressif's pinned toolchain image as delivered. Its ESP/Rust
# environment is rooted under /home/esp, while the project is a bind-mounted
# checkout. CI mounts CARGO_HOME separately to cache registry downloads without
# sharing target/, whose CMake state belongs to one build run.
CONTAINER_FLAGS := --rm --user "$(CONTAINER_USER)" -e HOME="$(CONTAINER_HOME)" \
	$(CONTAINER_CARGO_ENV) \
	-e GIT_CONFIG_COUNT=1 \
	-e GIT_CONFIG_KEY_0=safe.directory \
	-e GIT_CONFIG_VALUE_0="$(CONTAINER_GIT_SAFE_DIR)" \
	$(CONTAINER_EXTRA_FLAGS) \
	-v "$(ROOT_DIR):$(CONTAINER_WORKSPACE)" -w $(CONTAINER_WORKSPACE)/firmware/$(SRC)
CONTAINER_RUN := $(CONTAINER) run $(CONTAINER_FLAGS) $(IMAGE)

CAPTURE_SECS ?= 20

# Bounded serial capture helper; lives with the other dev tools and is
# stdlib-only so the system python3 can run it (the serial port is a host
# resource containers cannot reach).
CAPTURE_SCRIPT := ../tools/src/streamline_tools/serial_capture.py

.PHONY: image console-asset format lint lock lock-check build test openapi openapi-check pcm-frame-vectors flash monitor capture clean artifacts repro-check ota-size-check ota-size-self-test sign-self-test

image:
	$(CONTAINER) build -f $(SRC)/Dockerfile -t $(IMAGE) $(SRC)

console-asset:
	$(MAKE) -C $(CONSOLE_DIR) build

format: image
	$(CONTAINER_RUN) cargo fmt --all

# Refresh Cargo.lock from the manifest without upgrading dependencies, e.g.
# after a version bump. `--workspace` rewrites only the workspace members'
# own lock entries.
lock: image
	$(CONTAINER_RUN) cargo update --workspace

lock-check: image
	$(CONTAINER_RUN) cargo metadata --locked --no-deps --format-version 1 > /dev/null

# clippy runs `--lib` on the host target: the crate core is host-buildable while
# the `cfg(espidf)` adapters and binary only compile in the cross build, which
# `build` exercises with warnings intact.
lint: image console-asset
	$(CONTAINER_RUN) cargo fmt --all -- --check
	$(CONTAINER_RUN) cargo clippy --locked --lib -- -D warnings

build: image console-asset
	$(CONTAINER_RUN) cargo build --locked --release --target $(TARGET)

# The QEMU image variant: network over emulated Ethernet, audio skipped. It
# shares the hardware image's bootloader, partition table, and console asset,
# so QEMU exercises the same boot and API contracts without a radio.
qemu-build: image console-asset
	$(CONTAINER_RUN) cargo build --locked --release --target $(TARGET) --features qemu

test: image console-asset
	$(CONTAINER_RUN) cargo test --locked --lib

# Rust DTOs and endpoint declarations are the API source. The host-only
# `api-spec` feature keeps utoipa out of the device image.
openapi: image
	$(CONTAINER_RUN) cargo run --locked --quiet --features api-spec --bin streamline-openapi -- $(CONTAINER_WORKSPACE)/docs/openapi.json

openapi-check: image
	$(CONTAINER_RUN) bash -c 'cargo run --locked --quiet --features api-spec --bin streamline-openapi -- /tmp/openapi.json && diff -u $(CONTAINER_WORKSPACE)/docs/openapi.json /tmp/openapi.json'

# Regenerate the cross-language PCM frame conformance corpus from the encoder.
# `firmware-test` fails until the committed file matches; `bridge-test` fails
# until the Python parser matches the file.
pcm-frame-vectors: image
	$(CONTAINER_RUN) cargo run --locked --quiet --features pcm-frame-vectors --bin streamline-pcm-frame-vectors -- $(CONTAINER_WORKSPACE)/docs/pcm-frame-vectors.json

# Serial devices are host resources; Docker Desktop on macOS cannot expose the
# /dev/cu.* device reliably. Install espflash on the host for these two targets.
# Writes a consistent set for FLASH_SIZE — the rollback-enabled bootloader, the
# two-slot table, and the app, all with matching flash-size headers — so a dev
# flash lands the same layout a release `-full.bin` does. Without an explicit
# `--flash-size`, espflash can stamp an 8 MB header that panics a 4 MB chip on
# boot. `--erase-parts otadata` makes the freshly flashed slot the boot choice: a
# device whose last update arrived over OTA otherwise keeps booting the other
# slot, silently running the old image. Config in NVS survives.
flash: build
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash flash --chip esp32 --port $(PORT) --baud 921600 --flash-size $(FLASH_SIZE) --bootloader $(SRC)/target/$(TARGET)/release/bootloader.bin --partition-table $(SRC)/partitions.csv --erase-parts otadata $(SRC)/$(ELF)

monitor:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash monitor --chip esp32 --port $(PORT)

# Time-boxed, non-interactive capture for CI and agents that cannot drive the
# blocking interactive monitor. `make capture CAPTURE_SECS=30` resets the device
# and reads its serial output for a fixed window, then stops. Pass extra espflash
# monitor flags through CAPTURE_ARGS.
capture:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	python3 $(CAPTURE_SCRIPT) --seconds $(CAPTURE_SECS) --port $(PORT) --chip esp32 $(if $(wildcard $(SRC)/$(ELF)),--elf $(SRC)/$(ELF),) $(CAPTURE_ARGS)

clean: image
	$(CONTAINER_RUN) cargo clean

# Package the signed images for basename prefix $(1) (e.g. `streamline-0.9.0` or
# `streamline-qemu`). The firmware verifies vendor RSA-3072 signatures on
# over-the-air updates, so the application image must be signed to install, and
# the app embedded in the serial-flash image must be signed so the flashed
# device carries the key that verifies its next update:
#   1. elf2image with `--secure-pad-v2` reserves the signature sector.
#   2. espsecure.py appends the RSA signature block, signed with $(SIGNING_KEY)
#      (the committed dev key by default; release CI overrides it). Building
#      unsigned then signing keeps the private key off the build machine.
#   3. merge_bin lays the bootloader, the two-slot partition table, and the
#      SIGNED app into the offset-0 serial-flash image, so a USB/WebFlasher
#      install boots too. The table comes from partitions.csv (the layout applied
#      at flash time), not the ESP-IDF build's default single-app table.
define sign_and_package
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'set -e; export PATH="$(CONTAINER_WORKSPACE)/firmware/$(SRC)/.embuild/espressif/python_env/idf5.5_py3.11_env/bin:$$PATH"; ESPTOOL=$$(find .embuild -name esptool.py -path "*python_env*" | head -1); PY="$$(dirname "$$ESPTOOL")/python"; GENPART=$$(find .embuild -name gen_esp32part.py | head -1); REL=target/$(TARGET)/release; "$$PY" "$$ESPTOOL" --chip esp32 elf2image --flash_mode dio --flash_freq 40m --flash_size $(FLASH_SIZE_UPPER) --secure-pad-v2 -o /dist/firmware/$(1)-ota.bin $(ELF); espsecure.py sign_data --version 2 --keyfile $(SIGNING_KEY) -o /dist/firmware/$(1)-ota.bin.signed /dist/firmware/$(1)-ota.bin; mv /dist/firmware/$(1)-ota.bin.signed /dist/firmware/$(1)-ota.bin; "$$PY" "$$GENPART" partitions.csv /tmp/$(1)-partitions.bin; "$$PY" "$$ESPTOOL" --chip esp32 merge_bin --flash_mode dio --flash_freq 40m --flash_size $(FLASH_SIZE_UPPER) -o /dist/firmware/$(1)-full.bin 0x1000 $$REL/bootloader.bin 0x8000 /tmp/$(1)-partitions.bin 0x20000 /dist/firmware/$(1)-ota.bin'
endef

# `-full.bin` is the serial-flash image: it bundles the OTA-capable partition
# table and the rollback-enabled bootloader the ESP-IDF build produced, so a
# device flashed over USB lands on the two-slot layout that over-the-air updates
# need. `-ota.bin` is the bare application image the device pulls and writes into
# the inactive slot. Both carry the RSA signature block (see sign_and_package).
# SHA256SUMS stores basenames so the device can match the `-ota.bin` entry by
# filename, and hashes the signed bytes it actually serves.
artifacts: build
	mkdir -p $(DIST_DIR)/firmware
	$(call sign_and_package,streamline-$(VERSION))
	$(MAKE) ota-size-check OTA_IMAGE=$(DIST_DIR)/firmware/streamline-$(VERSION)-ota.bin
	$(MAKE) sign-self-test OTA_IMAGE=$(DIST_DIR)/firmware/streamline-$(VERSION)-ota.bin
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	cd $(DIST_DIR)/firmware && $(SHA256) streamline-$(VERSION)-full.bin streamline-$(VERSION)-ota.bin streamline-$(VERSION).elf > SHA256SUMS

# The packaged application image must fit its OTA slot with room to keep
# updating: refuse to package one that exceeds the slot minus the declared
# margin. The slot size is parsed from partitions.csv, so the budget cannot
# drift from the real layout, and the report states bytes, percentage, and
# remaining headroom so growth is visible before it blocks a release.
OTA_SIZE_MARGIN_BYTES ?= 65536
OTA_IMAGE ?= $(DIST_DIR)/firmware/streamline-$(VERSION)-ota.bin

ota-size-check:
	@set -eu; \
		image="$(OTA_IMAGE)"; \
		test -f "$$image" || { echo "ota-size-check: $$image not found; build it with: make artifacts VERSION=$(VERSION)" >&2; exit 2; }; \
		slot=$$(( $$(awk -F', *' '$$1 == "ota_0" { print $$5 }' $(SRC)/partitions.csv) )); \
		size=$$(wc -c < "$$image"); \
		limit=$$(( slot - $(OTA_SIZE_MARGIN_BYTES) )); \
		percent=$$(( size * 100 / slot )); \
		headroom=$$(( slot - size )); \
		echo "$$image: $$size bytes, $$percent% of the $$slot-byte slot, $$headroom bytes headroom ($(OTA_SIZE_MARGIN_BYTES)-byte margin)"; \
		test "$$size" -le "$$limit" || { echo "ota-size-check: image exceeds the slot budget ($$size > $$limit bytes)" >&2; exit 1; }

# Boundary fixtures prove the gate: an image exactly at the budget passes and
# one byte more fails.
ota-size-self-test:
	@set -eu; fixture="$$(mktemp -d)"; trap 'rm -rf "$$fixture"' EXIT INT TERM; \
		slot=$$(( $$(awk -F', *' '$$1 == "ota_0" { print $$5 }' $(SRC)/partitions.csv) )); \
		limit=$$(( slot - $(OTA_SIZE_MARGIN_BYTES) )); \
		dd if=/dev/zero of="$$fixture/fits.bin" bs=1 count=0 seek=$$limit 2>/dev/null; \
		dd if=/dev/zero of="$$fixture/overflows.bin" bs=1 count=0 seek=$$(( limit + 1 )) 2>/dev/null; \
		$(MAKE) ota-size-check OTA_IMAGE="$$fixture/fits.bin"; \
		if $(MAKE) ota-size-check OTA_IMAGE="$$fixture/overflows.bin" >/dev/null 2>&1; then \
			echo "ota-size-self-test: an oversized image must fail the gate" >&2; exit 1; \
		fi

# Prove the packaged application image is authentically signed: the intended key
# must verify it and a freshly generated foreign key must not. Guards the
# signing pipeline the way ota-size-self-test guards the size gate, and runs as
# part of `artifacts` so a mis-signed build never ships.
sign-self-test:
	@test -f "$(OTA_IMAGE)" || { echo "sign-self-test: $(OTA_IMAGE) not found; build it with: make artifacts VERSION=$(VERSION)" >&2; exit 2; }
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'set -e; export PATH="$(CONTAINER_WORKSPACE)/firmware/$(SRC)/.embuild/espressif/python_env/idf5.5_py3.11_env/bin:$$PATH"; image=/dist/firmware/$(notdir $(OTA_IMAGE)); espsecure.py verify_signature --version 2 --keyfile $(SIGNING_KEY) "$$image" >/dev/null; other=$$(mktemp -u); espsecure.py generate_signing_key --version 2 --scheme rsa3072 "$$other" >/dev/null 2>&1; if espsecure.py verify_signature --version 2 --keyfile "$$other" "$$image" >/dev/null 2>&1; then echo "sign-self-test: a foreign key must not verify the image" >&2; exit 1; fi; echo "sign-self-test: $(notdir $(OTA_IMAGE)) is signed by $(SIGNING_KEY) and rejects a foreign key"'

# Rebuilding one commit reproduces the compiled firmware byte-for-byte
# (CONFIG_APP_REPRODUCIBLE_BUILD in sdkconfig.defaults): the ELF, bootloader,
# and partition table. The packaged `-ota.bin`/`-full.bin` are deliberately not
# byte-reproducible — the appended RSA signature block carries fresh PSS salt
# each signing — so this checks the reproducible compiled inputs the signature
# attests over and leaves the signature out. Snapshots those outputs, rebuilds
# from a clean target, and compares; never touches the signed artifacts in dist.
repro-check:
	@test -f "$(SRC)/$(ELF)" || (echo "build first: make build VERSION=$(VERSION)" >&2; exit 2)
	@set -eu; snapshot="$$(mktemp -d)"; trap 'rm -rf "$$snapshot"' EXIT INT TERM; \
		rel="$(SRC)/target/$(TARGET)/release"; \
		files="streamline-firmware bootloader.bin partition-table.bin"; \
		for f in $$files; do cp "$$rel/$$f" "$$snapshot/"; done; \
		$(MAKE) clean; \
		$(MAKE) build VERSION=$(VERSION); \
		for f in $$files; do cmp "$$snapshot/$$f" "$$rel/$$f" || { echo "$$f is not reproducible" >&2; exit 1; }; done; \
		echo "repro-check: ELF, bootloader, and partition table are byte-reproducible (the RSA signature block intentionally is not)"

# The QEMU-emulated device's images: the merged image the smoke harness
# boots, and the bare application image its OTA test installs into the
# inactive slot. Runs the build and the packaging in one invocation because
# both variants share the ELF path — an interleaved `build` would package
# the wrong binary.
qemu-artifacts: qemu-build
	mkdir -p $(DIST_DIR)/firmware
	$(call sign_and_package,streamline-qemu)
	$(MAKE) ota-size-check OTA_IMAGE=$(DIST_DIR)/firmware/streamline-qemu-ota.bin
	$(MAKE) sign-self-test OTA_IMAGE=$(DIST_DIR)/firmware/streamline-qemu-ota.bin
