include ../mk/common.mk

IMAGE := esp32-streamline-firmware
SRC := streamline
TARGET := xtensa-esp32-espidf
ELF := target/$(TARGET)/release/streamline-firmware
VERSION ?= dev
FEATURES ?=
# Must match CONFIG_ESPTOOLPY_FLASHSIZE in streamline/sdkconfig.defaults.
FLASH_SIZE ?= 4mb
FLASH_SIZE_UPPER := $(shell echo $(FLASH_SIZE) | tr a-z A-Z)
# Relative to firmware/streamline. See docs/ota.md#firmware-signing.
DEV_SIGNING_KEY := .dev_signing_key.pem
SIGNING_KEY ?= $(DEV_SIGNING_KEY)
DIST_DIR ?= $(abspath ../dist)
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
CONTAINER_MOUNT := -v "$(ROOT_DIR):$(CONTAINER_WORKSPACE)" -w $(CONTAINER_WORKSPACE)/firmware/$(SRC)

# The toolchain image roots its environment in /home/esp. CI mounts CARGO_HOME
# to cache downloads; target/ holds one run's CMake state and is never shared.
CONTAINER_FLAGS := --rm --user "$(CONTAINER_USER)" -e HOME="$(CONTAINER_HOME)" \
	$(CONTAINER_CARGO_ENV) \
	-e GIT_CONFIG_COUNT=1 \
	-e GIT_CONFIG_KEY_0=safe.directory \
	-e GIT_CONFIG_VALUE_0="$(CONTAINER_GIT_SAFE_DIR)" \
	$(CONTAINER_EXTRA_FLAGS) \
	$(CONTAINER_MOUNT)
CONTAINER_RUN := $(CONTAINER) run $(CONTAINER_FLAGS) $(IMAGE)
# Runs as the invoking user, so the development key stays host-owned and deletable.
CONTAINER_RUN_HOST_USER := $(CONTAINER) run --rm --user "$(CONTAINER_HOST_USER)" $(CONTAINER_MOUNT) $(IMAGE)

# ESP-IDF's Python environment, whose path embeds the ESP-IDF and Python versions.
# Needs a completed build.
IDF_PYTHON_ENV := ESPTOOL="$$(find .embuild -name esptool.py -path "*python_env*" | head -1)"; test -n "$$ESPTOOL" || { echo "ESP-IDF python env not found; run: make -C firmware build" >&2; exit 1; }; PY="$$(dirname "$$ESPTOOL")/python"; export PATH="$$(dirname "$$ESPTOOL"):$$PATH"

CAPTURE_SECS ?= 20

# Runs on the host python3: containers cannot reach the serial port.
CAPTURE_SCRIPT := ../tools/src/streamline_tools/serial_capture.py

.PHONY: image console-asset format lint lock lock-check build test openapi openapi-check pcm-frame-vectors flash monitor capture clean artifacts package repro-check ota-size-check ota-size-self-test signature-check signing-key size-report

image:
	$(CONTAINER) build -f $(SRC)/Dockerfile -t $(IMAGE) $(SRC)

console-asset:
	$(MAKE) -C $(CONSOLE_DIR) build

format: image
	$(CONTAINER_RUN) cargo fmt --all

# Rewrites only the workspace's own lock entries; dependencies stay put.
lock: image
	$(CONTAINER_RUN) cargo update --workspace

lock-check: image
	$(CONTAINER_RUN) cargo metadata --locked --no-deps --format-version 1 > /dev/null

# One clippy pass per configuration the crate compiles in. No pass compiles
# device `#[cfg(test)]` code.
lint: image console-asset
	$(CONTAINER_RUN) cargo fmt --all -- --check
	$(CONTAINER_RUN) cargo clippy --locked --lib -- -D warnings
	$(CONTAINER_RUN) cargo clippy --locked --lib --tests -- -D warnings
	$(CONTAINER_RUN) cargo clippy --locked --features api-spec,pcm-frame-vectors \
		--lib --bin streamline-openapi --bin streamline-pcm-frame-vectors -- -D warnings
	$(CONTAINER_RUN) cargo clippy --locked --release --target $(TARGET) -- -D warnings
	$(CONTAINER_RUN) cargo clippy --locked --release --target $(TARGET) --features qemu -- -D warnings
	$(CONTAINER_RUN) cargo clippy --locked --release --target $(TARGET) --features qemu-fail-management -- -D warnings
	$(CONTAINER_RUN) cargo clippy --locked --release --target $(TARGET) --features test-source -- -D warnings

build: image console-asset
	$(CONTAINER_RUN) cargo build --locked --release --target $(TARGET) $(if $(FEATURES),--features $(FEATURES))

size-report: build
	$(MAKE) -C ../tools size-report

# Emulated Ethernet and no audio, with the hardware image's boot and API contracts.
qemu-build: image console-asset
	$(CONTAINER_RUN) cargo build --locked --release --target $(TARGET) --features qemu

test: image console-asset
	$(CONTAINER_RUN) cargo test --locked --lib

openapi: image
	$(CONTAINER_RUN) cargo run --locked --quiet --features api-spec --bin streamline-openapi -- $(CONTAINER_WORKSPACE)/docs/openapi.json

openapi-check: image
	$(CONTAINER_RUN) bash -c 'cargo run --locked --quiet --features api-spec --bin streamline-openapi -- /tmp/openapi.json && diff -u $(CONTAINER_WORKSPACE)/docs/openapi.json /tmp/openapi.json'

# The PCM frame corpus the firmware and bridge tests both check against.
pcm-frame-vectors: image
	$(CONTAINER_RUN) cargo run --locked --quiet --features pcm-frame-vectors --bin streamline-pcm-frame-vectors -- $(CONTAINER_WORKSPACE)/docs/pcm-frame-vectors.json

# Serial targets run espflash on the host; README.md#development says why.

# An explicit --flash-size stops espflash stamping a header the chip cannot boot.
# Erasing otadata boots the flashed slot rather than an earlier OTA slot; NVS
# configuration survives.
flash: build
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash flash --chip esp32 --baud 921600 --flash-size $(FLASH_SIZE) --bootloader $(SRC)/target/$(TARGET)/release/bootloader.bin --partition-table $(SRC)/partitions.csv --erase-parts otadata $(SRC)/$(ELF)

monitor:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash monitor --chip esp32

# Extra espflash monitor flags go through CAPTURE_ARGS.
capture:
	python3 $(CAPTURE_SCRIPT) --seconds $(CAPTURE_SECS) --chip esp32 $(if $(wildcard $(SRC)/$(ELF)),--elf $(SRC)/$(ELF),) $(CAPTURE_ARGS)

clean: image
	$(CONTAINER_RUN) cargo clean

# A missing development key is generated; any other key must exist, so a release
# never signs with a throwaway key.
signing-key: image
	@set -e; \
		if [ -f "$(SRC)/$(SIGNING_KEY)" ]; then exit 0; fi; \
		if [ "$(SIGNING_KEY)" != "$(DEV_SIGNING_KEY)" ]; then \
			echo "signing key $(SIGNING_KEY) not found" >&2; exit 1; \
		fi; \
		echo "generating a development signing key ($(SIGNING_KEY)); it stays out of git"; \
		$(CONTAINER_RUN_HOST_USER) bash -ec '$(IDF_PYTHON_ENV); espsecure.py generate_signing_key --version 2 --scheme rsa3072 $(DEV_SIGNING_KEY) >/dev/null'; \
		chmod 600 "$(SRC)/$(SIGNING_KEY)"

# Packages basename $(1): the signed OTA image, and the full image that adds the
# bootloader and the partitions.csv table. See docs/ota.md#build-artifacts.
define sign_and_package
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'set -e; $(IDF_PYTHON_ENV); GENPART="$$IDF_PATH/components/partition_table/gen_esp32part.py"; REL=target/$(TARGET)/release; "$$PY" "$$ESPTOOL" --chip esp32 elf2image --flash_mode dio --flash_freq 40m --flash_size $(FLASH_SIZE_UPPER) --secure-pad-v2 -o /dist/firmware/$(1)-ota.bin $(ELF); espsecure.py sign_data --version 2 --keyfile $(SIGNING_KEY) -o /dist/firmware/$(1)-ota.bin.signed /dist/firmware/$(1)-ota.bin; mv /dist/firmware/$(1)-ota.bin.signed /dist/firmware/$(1)-ota.bin; "$$PY" "$$GENPART" partitions.csv /tmp/$(1)-partitions.bin; "$$PY" "$$ESPTOOL" --chip esp32 merge_bin --flash_mode dio --flash_freq 40m --flash_size $(FLASH_SIZE_UPPER) -o /dist/firmware/$(1)-full.bin 0x1000 $$REL/bootloader.bin 0x8000 /tmp/$(1)-partitions.bin 0x20000 /dist/firmware/$(1)-ota.bin'
endef

# SHA256SUMS lists basenames: the device finds its `-ota.bin` entry by name.
artifacts: build
	$(MAKE) package

package: signing-key
	mkdir -p $(DIST_DIR)/firmware
	$(call sign_and_package,streamline-$(VERSION))
	$(MAKE) ota-size-check OTA_IMAGE=$(DIST_DIR)/firmware/streamline-$(VERSION)-ota.bin
	$(MAKE) signature-check OTA_IMAGE=$(DIST_DIR)/firmware/streamline-$(VERSION)-ota.bin
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	cd $(DIST_DIR)/firmware && $(SHA256) streamline-$(VERSION)-full.bin streamline-$(VERSION)-ota.bin streamline-$(VERSION).elf > SHA256SUMS

# The OTA image must fit its partitions.csv slot minus the margin.
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

signature-check:
	@test -f "$(OTA_IMAGE)" || { echo "signature-check: $(OTA_IMAGE) not found; build it with: make artifacts VERSION=$(VERSION)" >&2; exit 2; }
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'set -e; $(IDF_PYTHON_ENV); image=/dist/firmware/$(notdir $(OTA_IMAGE)); espsecure.py verify_signature --version 2 --keyfile $(SIGNING_KEY) "$$image" >/dev/null; other=$$(mktemp -u); espsecure.py generate_signing_key --version 2 --scheme rsa3072 "$$other" >/dev/null 2>&1; if espsecure.py verify_signature --version 2 --keyfile "$$other" "$$image" >/dev/null 2>&1; then echo "signature-check: a foreign key must not verify the image" >&2; exit 1; fi; echo "signature-check: $(notdir $(OTA_IMAGE)) is signed by $(SIGNING_KEY) and rejects a foreign key"'

# The ELF, bootloader and partition table are byte-reproducible. Signed images
# are not: each RSA-PSS signature carries fresh salt.
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

# Variants build and package in sequence because they share one ELF path.
qemu-artifacts: qemu-build signing-key
	mkdir -p $(DIST_DIR)/firmware
	$(call sign_and_package,streamline-qemu)
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-qemu.elf
	$(MAKE) ota-size-check OTA_IMAGE=$(DIST_DIR)/firmware/streamline-qemu-ota.bin
	$(MAKE) signature-check OTA_IMAGE=$(DIST_DIR)/firmware/streamline-qemu-ota.bin
	$(CONTAINER_RUN) cargo build --locked --release --target $(TARGET) --features qemu-fail-management
	$(call sign_and_package,streamline-qemu-fail-management)
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-qemu-fail-management.elf
