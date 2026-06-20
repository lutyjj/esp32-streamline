IMAGE := esp32-streamline-firmware
SRC := streamline
TARGET := xtensa-esp32-espidf
ELF := target/$(TARGET)/release/streamline-firmware
VERSION ?= dev
PORT ?= /dev/cu.usbserial-0001
DIST_DIR ?= $(abspath ../dist)

.PHONY: image format lint build test flash monitor clean artifacts

image:
	docker build -f $(SRC)/Dockerfile -t $(IMAGE) $(SRC)

format: image
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -w /workspace $(IMAGE) cargo fmt --all

lint: image
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -w /workspace $(IMAGE) cargo fmt --all -- --check
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -w /workspace $(IMAGE) cargo clippy --lib -- -D warnings

build: image
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -w /workspace $(IMAGE) cargo build --release --target $(TARGET)

test: image
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -w /workspace $(IMAGE) cargo test --lib

# Serial devices are host resources; Docker Desktop on macOS cannot expose the
# /dev/cu.* device reliably. Install espflash on the host for these two targets.
flash: build
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash flash --chip esp32 --port $(PORT) $(SRC)/$(ELF)

monitor:
	@command -v espflash >/dev/null || (echo "install espflash on the host: cargo install espflash" >&2; exit 2)
	espflash monitor --chip esp32 --port $(PORT)

clean: image
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -w /workspace $(IMAGE) cargo clean

artifacts: build
	mkdir -p $(DIST_DIR)/firmware
	docker run --rm -v "$(CURDIR)/$(SRC):/workspace" -v "$(DIST_DIR):/dist" -w /workspace $(IMAGE) espflash save-image --chip esp32 $(ELF) /dist/firmware/streamline-$(VERSION)-full.bin --merge --skip-padding
	cp $(SRC)/$(ELF) $(DIST_DIR)/firmware/streamline-$(VERSION).elf
	shasum -a 256 $(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin $(DIST_DIR)/firmware/streamline-$(VERSION).elf > $(DIST_DIR)/firmware/SHA256SUMS
