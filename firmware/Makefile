IMAGE := esp32-streamline-firmware-tools
TARGET ?= codec-scan
DIR_codec-scan := diagnostics/codec-scan
DIR_audio-level := diagnostics/audio-level
DIR_streamline := streamline
ENV_codec-scan := codec-scan
ENV_audio-level := audio-level
ENV_streamline := stream
PROJECT_DIR = $(DIR_$(TARGET))
PROJECT_ENV = $(ENV_$(TARGET))
VERSION ?= dev
PORT ?= /dev/cu.usbserial-0001
PLATFORMIO_CACHE_VOLUME ?= esp32-streamline-platformio
DIST_DIR ?= $(abspath ../dist)

.PHONY: image format lint build flash flash-full monitor clean artifacts

image:
	docker build -f Dockerfile -t $(IMAGE) .

format: image
	docker run --rm -v "$(CURDIR):/workspace" -w /workspace $(IMAGE) sh -c 'find . -type d -name .pio -prune -o -path "*/src/*.cpp" -type f -exec clang-format -i {} +'

lint: image
	docker run --rm -v "$(CURDIR):/workspace" -w /workspace $(IMAGE) sh -c 'find . -type d -name .pio -prune -o -path "*/src/*.cpp" -type f -exec clang-format --dry-run --Werror {} +'

build: image
	@test -n "$(PROJECT_DIR)" || (echo "unknown TARGET=$(TARGET)" >&2; exit 2)
	docker run --rm -v "$(CURDIR):/workspace" -v "$(PLATFORMIO_CACHE_VOLUME):/platformio" -e PLATFORMIO_CORE_DIR=/platformio -e STREAMLINE_VERSION=$(VERSION) -w /workspace/$(PROJECT_DIR) $(IMAGE) pio run

flash:
	@test -n "$(PROJECT_DIR)" || (echo "unknown TARGET=$(TARGET)" >&2; exit 2)
	esptool --chip esp32 --port $(PORT) --baud 460800 write-flash 0x1000 $(PROJECT_DIR)/.pio/build/$(PROJECT_ENV)/bootloader.bin 0x8000 $(PROJECT_DIR)/.pio/build/$(PROJECT_ENV)/partitions.bin 0x10000 $(PROJECT_DIR)/.pio/build/$(PROJECT_ENV)/firmware.bin

flash-full:
	@test -f $(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin || (echo "run make artifacts VERSION=$(VERSION) first" >&2; exit 2)
	esptool --chip esp32 --port $(PORT) --baud 460800 write-flash 0x0 $(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin

monitor:
	esptool --port $(PORT) run
	screen $(PORT) 115200

clean: image
	@test -n "$(PROJECT_DIR)" || (echo "unknown TARGET=$(TARGET)" >&2; exit 2)
	docker run --rm -v "$(CURDIR):/workspace" -v "$(PLATFORMIO_CACHE_VOLUME):/platformio" -e PLATFORMIO_CORE_DIR=/platformio -w /workspace/$(PROJECT_DIR) $(IMAGE) pio run -t clean

artifacts: TARGET = streamline
artifacts: build image
	mkdir -p $(DIST_DIR)/firmware
	cp streamline/.pio/build/stream/bootloader.bin $(DIST_DIR)/firmware/streamline-$(VERSION)-bootloader.bin
	cp streamline/.pio/build/stream/partitions.bin $(DIST_DIR)/firmware/streamline-$(VERSION)-partitions.bin
	cp streamline/.pio/build/stream/firmware.bin $(DIST_DIR)/firmware/streamline-$(VERSION).bin
	docker run --rm -v "$(CURDIR):/workspace" -v "$(DIST_DIR):/dist" -v "$(PLATFORMIO_CACHE_VOLUME):/platformio" -w /workspace/streamline $(IMAGE) python /platformio/packages/tool-esptoolpy/esptool.py --chip esp32 merge_bin --output /dist/firmware/streamline-$(VERSION)-full.bin --flash_mode keep --flash_freq keep --flash_size keep 0x1000 .pio/build/stream/bootloader.bin 0x8000 .pio/build/stream/partitions.bin 0x10000 .pio/build/stream/firmware.bin
	shasum -a 256 $(DIST_DIR)/firmware/streamline-$(VERSION)*.bin > $(DIST_DIR)/firmware/SHA256SUMS
