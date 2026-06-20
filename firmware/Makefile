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
DOCKER_FLAGS := --rm --user 0:0 -e HOME=/home/esp \
	-v "$(CURDIR)/$(SRC):/workspace" -w /workspace
DOCKER_RUN := docker run $(DOCKER_FLAGS) $(IMAGE)

.PHONY: image format lint build test flash monitor clean artifacts

image:
	docker build -f $(SRC)/Dockerfile -t $(IMAGE) $(SRC)

format: image
	$(DOCKER_RUN) cargo fmt --all

lint: image
	$(DOCKER_RUN) cargo fmt --all -- --check
	$(DOCKER_RUN) cargo clippy --lib -- -D warnings

build: image
	$(DOCKER_RUN) cargo build --release --target $(TARGET)

test: image
	$(DOCKER_RUN) cargo test --lib

# Serial devices are host resources; Docker Desktop on macOS cannot expose the
# /dev/cu.* device reliably. Install espflash on the host for these two targets.
flash: build
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash flash --chip esp32 --port $(PORT) $(SRC)/$(ELF)

monitor:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash monitor --chip esp32 --port $(PORT)

clean: image
	$(DOCKER_RUN) cargo clean

# `-full.bin` is the serial-flash image: it bundles the OTA-capable partition
# table and the rollback-enabled bootloader the ESP-IDF build produced, so a
# device flashed over USB lands on the two-slot layout that over-the-air updates
# need. `-ota.bin` is the bare application image the device pulls and writes into
# the inactive slot. SHA256SUMS stores basenames so the device can match the
# `-ota.bin` entry by filename.
artifacts: build
	mkdir -p $(DIST_DIR)/firmware
	docker run $(DOCKER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) espflash save-image --chip esp32 $(ELF) /dist/firmware/streamline-$(VERSION)-full.bin --merge --skip-padding --flash-size 8mb --bootloader target/$(TARGET)/release/bootloader.bin --partition-table partitions.csv
	docker run $(DOCKER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) bash -c 'ESPTOOL=$$(find .embuild -name esptool.py -path "*python_env*" | head -1); "$$(dirname "$$ESPTOOL")/python" "$$ESPTOOL" --chip esp32 elf2image --flash_mode dio --flash_freq 40m --flash_size 8MB -o /dist/firmware/streamline-$(VERSION)-ota.bin $(ELF)'
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	cd $(DIST_DIR)/firmware && shasum -a 256 streamline-$(VERSION)-full.bin streamline-$(VERSION)-ota.bin streamline-$(VERSION).elf > SHA256SUMS
