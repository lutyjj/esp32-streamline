include ../mk/container.mk

IMAGE := esp32-streamline-firmware
SRC := streamline
TARGET := xtensa-esp32-espidf
ELF := target/$(TARGET)/release/streamline-firmware
VERSION ?= dev
PORT ?= /dev/cu.usbserial-0001
DIST_DIR ?= $(abspath ../dist)

# Run cargo in the toolchain image as root with the image user's HOME so the
# rustup toolchain resolves normally. Root is required because CI checks out the
# workspace as the runner UID, which the image's unprivileged user cannot write
# (cargo target/, esp-idf .embuild/). On macOS the bind mount is UID-mapped, so
# artifacts still land readable on the host.
CONTAINER_FLAGS := --rm --user 0:0 -e HOME=/home/esp \
	-v "$(CURDIR)/$(SRC):/workspace" -w /workspace
CONTAINER_RUN := $(CONTAINER) run $(CONTAINER_FLAGS) $(IMAGE)

CAPTURE_SECS ?= 20

.PHONY: image format lint build test flash monitor capture clean artifacts

image:
	$(CONTAINER) build -f $(SRC)/Dockerfile -t $(IMAGE) $(SRC)

format: image
	$(CONTAINER_RUN) cargo fmt --all

lint: image
	$(CONTAINER_RUN) cargo fmt --all -- --check
	$(CONTAINER_RUN) cargo clippy --lib -- -D warnings

build: image
	$(CONTAINER_RUN) cargo build --release --target $(TARGET)

test: image
	$(CONTAINER_RUN) cargo test --lib

# Serial devices are host resources; Docker Desktop on macOS cannot expose the
# /dev/cu.* device reliably. Install espflash on the host for these two targets.
flash: build
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash flash --chip esp32 --port $(PORT) $(SRC)/$(ELF)

monitor:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash monitor --chip esp32 --port $(PORT)

# Time-boxed, non-interactive capture for CI and agents that cannot drive the
# blocking interactive monitor. `make capture CAPTURE_SECS=30` resets the device
# and reads its serial output for a fixed window, then stops. Pass extra espflash
# monitor flags through CAPTURE_ARGS.
capture:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	python3 scripts/capture.py --seconds $(CAPTURE_SECS) --port $(PORT) --chip esp32 $(if $(wildcard $(SRC)/$(ELF)),--elf $(SRC)/$(ELF),) $(CAPTURE_ARGS)

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
