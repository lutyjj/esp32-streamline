include ../mk/common.mk

IMAGE := esp32-streamline-firmware
SRC := streamline
TARGET := xtensa-esp32-espidf
ELF := target/$(TARGET)/release/streamline-firmware
VERSION ?= dev
PORT ?= /dev/cu.usbserial-0001
DIST_DIR ?= $(abspath ../dist)
ROOT_DIR := $(abspath ..)
CONSOLE_DIR := $(ROOT_DIR)/console

# Run cargo in the toolchain image as root with the image user's HOME so the
# rustup toolchain resolves normally. Root is required because CI checks out the
# workspace as the runner UID, which the image's unprivileged user cannot write
# (cargo target/, esp-idf .embuild/). On macOS the bind mount is UID-mapped, so
# artifacts still land readable on the host.
CONTAINER_FLAGS := --rm --user 0:0 -e HOME=/home/esp \
	-v "$(ROOT_DIR):/repo" -w /repo/firmware/$(SRC)
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
# `--erase-parts otadata` makes the freshly flashed slot the boot choice: a
# device whose last update arrived over OTA otherwise keeps booting the other
# slot, silently running the old image. Config in NVS survives.
flash: build
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash flash --chip esp32 --port $(PORT) --partition-table $(SRC)/partitions.csv --erase-parts otadata $(SRC)/$(ELF)

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
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) espflash save-image --chip esp32 $(ELF) /dist/firmware/streamline-$(VERSION)-full.bin --merge --skip-padding --flash-size 8mb --bootloader target/$(TARGET)/release/bootloader.bin --partition-table partitions.csv
	$(CONTAINER) run $(CONTAINER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'ESPTOOL=$$(find .embuild -name esptool.py -path "*python_env*" | head -1); "$$(dirname "$$ESPTOOL")/python" "$$ESPTOOL" --chip esp32 elf2image --flash_mode dio --flash_freq 40m --flash_size 8MB -o /dist/firmware/streamline-$(VERSION)-ota.bin $(ELF)'
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	cd $(DIST_DIR)/firmware && shasum -a 256 streamline-$(VERSION)-full.bin streamline-$(VERSION)-ota.bin streamline-$(VERSION).elf > SHA256SUMS
