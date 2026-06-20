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

artifacts: build
	mkdir -p $(DIST_DIR)/firmware
	docker run $(DOCKER_FLAGS) -v "$(DIST_DIR):/dist" $(IMAGE) espflash save-image --chip esp32 $(ELF) /dist/firmware/streamline-$(VERSION)-full.bin --merge --skip-padding
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	shasum -a 256 $(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin $(DIST_DIR)/firmware/streamline-$(VERSION).elf > $(DIST_DIR)/firmware/SHA256SUMS
