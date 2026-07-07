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
DIST_DIR ?= $(abspath ../dist)
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

.PHONY: image console-asset format lint build test flash monitor capture clean artifacts

image:
	$(CONTAINER) build -f $(SRC)/Dockerfile -t $(IMAGE) $(SRC)

console-asset:
	$(MAKE) -C $(CONSOLE_DIR) build

format: image
	$(CONTAINER_RUN) cargo fmt --all

# clippy runs `--lib` on the host target: the crate core is host-buildable while
# the `cfg(espidf)` adapters and binary only compile in the cross build, which
# `build` exercises with warnings intact.
lint: image console-asset
	$(CONTAINER_RUN) cargo fmt --all -- --check
	$(CONTAINER_RUN) cargo clippy --lib -- -D warnings

build: image console-asset
	$(CONTAINER_RUN) cargo build --release --target $(TARGET)

test: image console-asset
	$(CONTAINER_RUN) cargo test --lib

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
	espflash flash --chip esp32 --port $(PORT) --flash-size $(FLASH_SIZE) --bootloader $(SRC)/target/$(TARGET)/release/bootloader.bin --partition-table $(SRC)/partitions.csv --erase-parts otadata $(SRC)/$(ELF)

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

# `-full.bin` is the serial-flash image: it bundles the OTA-capable partition
# table and the rollback-enabled bootloader the ESP-IDF build produced, so a
# device flashed over USB lands on the two-slot layout that over-the-air updates
# need. `-ota.bin` is the bare application image the device pulls and writes into
# the inactive slot. SHA256SUMS stores basenames so the device can match the
# `-ota.bin` entry by filename.
artifacts: build
	mkdir -p $(DIST_DIR)/firmware
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) espflash save-image --chip esp32 $(ELF) /dist/firmware/streamline-$(VERSION)-full.bin --merge --skip-padding --flash-size $(FLASH_SIZE) --bootloader target/$(TARGET)/release/bootloader.bin --partition-table partitions.csv
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'ESPTOOL=$$(find .embuild -name esptool.py -path "*python_env*" | head -1); "$$(dirname "$$ESPTOOL")/python" "$$ESPTOOL" --chip esp32 elf2image --flash_mode dio --flash_freq 40m --flash_size $(FLASH_SIZE_UPPER) -o /dist/firmware/streamline-$(VERSION)-ota.bin $(ELF)'
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	cd $(DIST_DIR)/firmware && shasum -a 256 streamline-$(VERSION)-full.bin streamline-$(VERSION)-ota.bin streamline-$(VERSION).elf > SHA256SUMS
