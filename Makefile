TOOLS_IMAGE := esp32-streamline-tools
ANALYSIS_IMAGE := esp32-streamline-analysis
BRIDGE_IMAGE ?= esp32-streamline-bridge
BRIDGE_ARGS ?=
BRIDGE_PORTS ?= -p 39000:39000 -p 8088:8088
PROJECT_VERSION := $(shell sed -n 's/^version = "\([^"]*\)"/\1/p' bridge/pyproject.toml)
VERSION ?= $(PROJECT_VERSION)
FIRMWARE_TARGET ?= codec-scan
FIRMWARE_DIR_codec-scan := firmware/diagnostics/codec-scan
FIRMWARE_DIR_audio-level := firmware/diagnostics/audio-level
FIRMWARE_DIR_streamline := firmware/streamline
FIRMWARE_ENV_codec-scan := codec-scan
FIRMWARE_ENV_audio-level := audio-level
FIRMWARE_ENV_streamline := stream
FIRMWARE_DIR := $(FIRMWARE_DIR_$(FIRMWARE_TARGET))
FIRMWARE_ENV := $(FIRMWARE_ENV_$(FIRMWARE_TARGET))
PORT ?= /dev/cu.usbserial-0001
PLATFORMIO_CACHE_VOLUME ?= esp32-streamline-platformio
TOOLS_CACHE_VOLUME ?= esp32-streamline-tools-cache
DIST_DIR ?= dist

.PHONY: check lint test format clean \
	tools-image analysis-image \
	bridge-format bridge-lint bridge-test bridge-image bridge-run bridge-up \
	firmware-format firmware-lint firmware-build firmware-streamline firmware-audio-level firmware-codec-scan firmware-flash firmware-flash-full firmware-monitor firmware-clean firmware-artifacts \
	analysis-lint analysis-capture \
	version-check release

tools-image:
	docker build -f containers/firmware-tools.Dockerfile -t $(TOOLS_IMAGE) .

analysis-image:
	docker build -f containers/analysis.Dockerfile -t $(ANALYSIS_IMAGE) .

check: lint test

format: bridge-format firmware-format

lint: bridge-lint firmware-lint analysis-lint

test: bridge-test firmware-codec-scan firmware-audio-level firmware-streamline

bridge-format: tools-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(TOOLS_CACHE_VOLUME):/cache" \
		-e RUFF_CACHE_DIR=/cache/ruff \
		-w /workspace/bridge \
		$(TOOLS_IMAGE) \
		sh -c 'ruff check --select I --fix src tests && ruff format src tests'

bridge-lint: tools-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(TOOLS_CACHE_VOLUME):/cache" \
		-e RUFF_CACHE_DIR=/cache/ruff \
		-e MYPY_CACHE_DIR=/cache/mypy \
		-w /workspace/bridge \
		$(TOOLS_IMAGE) \
		sh -c 'ruff format --check src tests && ruff check src tests && mypy'

bridge-test: tools-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-e PYTHONDONTWRITEBYTECODE=1 \
		-e PYTHONPATH=/workspace/bridge/src \
		-w /workspace/bridge \
		$(TOOLS_IMAGE) \
		python3 -m unittest discover -s tests -v

bridge-image:
	docker build -f bridge/Dockerfile --build-arg VERSION=$(VERSION) -t $(BRIDGE_IMAGE):$(VERSION) bridge

bridge-run: bridge-image
	docker run --rm $(BRIDGE_PORTS) $(BRIDGE_IMAGE):$(VERSION) $(BRIDGE_ARGS)

bridge-up:
	STREAMLINE_VERSION=$(VERSION) docker compose -f bridge/compose.yaml up -d --build

firmware-format: tools-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-w /workspace \
		$(TOOLS_IMAGE) \
		sh -c 'find firmware -type d -name .pio -prune -o -path "*/src/*.cpp" -type f -exec clang-format -i {} +'

firmware-lint: tools-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-w /workspace \
		$(TOOLS_IMAGE) \
		sh -c 'find firmware -type d -name .pio -prune -o -path "*/src/*.cpp" -type f -exec clang-format --dry-run --Werror {} +'

firmware-build: tools-image
	@test -n "$(FIRMWARE_DIR)" || (echo "unknown FIRMWARE_TARGET=$(FIRMWARE_TARGET)" >&2; exit 2)
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(PLATFORMIO_CACHE_VOLUME):/platformio" \
		-e PLATFORMIO_CORE_DIR=/platformio \
		-e STREAMLINE_VERSION=$(VERSION) \
		-w /workspace/$(FIRMWARE_DIR) \
		$(TOOLS_IMAGE) \
		pio run

firmware-streamline:
	$(MAKE) firmware-build FIRMWARE_TARGET=streamline

firmware-audio-level:
	$(MAKE) firmware-build FIRMWARE_TARGET=audio-level

firmware-codec-scan:
	$(MAKE) firmware-build FIRMWARE_TARGET=codec-scan

firmware-flash:
	@test -n "$(FIRMWARE_DIR)" || (echo "unknown FIRMWARE_TARGET=$(FIRMWARE_TARGET)" >&2; exit 2)
	esptool --chip esp32 --port $(PORT) --baud 460800 write-flash \
		0x1000 $(FIRMWARE_DIR)/.pio/build/$(FIRMWARE_ENV)/bootloader.bin \
		0x8000 $(FIRMWARE_DIR)/.pio/build/$(FIRMWARE_ENV)/partitions.bin \
		0x10000 $(FIRMWARE_DIR)/.pio/build/$(FIRMWARE_ENV)/firmware.bin

firmware-flash-full:
	@test -f $(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin || (echo "run make firmware-artifacts VERSION=$(VERSION) first" >&2; exit 2)
	esptool --chip esp32 --port $(PORT) --baud 460800 write-flash \
		0x0 $(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin

firmware-monitor:
	esptool --port $(PORT) run
	screen $(PORT) 115200

firmware-clean: tools-image
	@test -n "$(FIRMWARE_DIR)" || (echo "unknown FIRMWARE_TARGET=$(FIRMWARE_TARGET)" >&2; exit 2)
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(PLATFORMIO_CACHE_VOLUME):/platformio" \
		-e PLATFORMIO_CORE_DIR=/platformio \
		-w /workspace/$(FIRMWARE_DIR) \
		$(TOOLS_IMAGE) \
		pio run -t clean

firmware-artifacts: firmware-streamline
	mkdir -p $(DIST_DIR)/firmware
	cp firmware/streamline/.pio/build/stream/bootloader.bin $(DIST_DIR)/firmware/streamline-$(VERSION)-bootloader.bin
	cp firmware/streamline/.pio/build/stream/partitions.bin $(DIST_DIR)/firmware/streamline-$(VERSION)-partitions.bin
	cp firmware/streamline/.pio/build/stream/firmware.bin $(DIST_DIR)/firmware/streamline-$(VERSION).bin
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(PLATFORMIO_CACHE_VOLUME):/platformio" \
		-w /workspace/firmware/streamline \
		$(TOOLS_IMAGE) \
		python /platformio/packages/tool-esptoolpy/esptool.py --chip esp32 merge_bin \
			--output /workspace/$(DIST_DIR)/firmware/streamline-$(VERSION)-full.bin \
			--flash_mode keep --flash_freq keep --flash_size keep \
			0x1000 .pio/build/stream/bootloader.bin \
			0x8000 .pio/build/stream/partitions.bin \
			0x10000 .pio/build/stream/firmware.bin
	shasum -a 256 $(DIST_DIR)/firmware/streamline-$(VERSION)*.bin > $(DIST_DIR)/firmware/SHA256SUMS

analysis-lint: analysis-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(TOOLS_CACHE_VOLUME):/cache" \
		-e MYPY_CACHE_DIR=/cache/mypy-analysis \
		-w /workspace \
		$(ANALYSIS_IMAGE) \
		mypy --strict tools/analyze_capture.py

analysis-capture: analysis-image
	@test -n "$(REF)" || (echo "REF=/path/to/reference.flac is required" >&2; exit 2)
	@test -n "$(CAP)" || (echo "CAP=/path/to/capture.wav is required" >&2; exit 2)
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(HOME):$(HOME):ro" \
		-v /tmp:/tmp \
		-w /workspace \
		$(ANALYSIS_IMAGE) \
		python3 tools/analyze_capture.py --reference "$(REF)" --capture "$(CAP)"

version-check:
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	@test "$(VERSION)" = "$(PROJECT_VERSION)" || (echo "VERSION=$(VERSION) does not match bridge/pyproject.toml ($(PROJECT_VERSION))" >&2; exit 2)
	@printf '%s' "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$$' || (echo "VERSION must be a semantic version" >&2; exit 2)

release: version-check check firmware-artifacts bridge-image

clean: firmware-clean
