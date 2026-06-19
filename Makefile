PIO_IMAGE := esp32-streamline-platformio
ANALYSIS_IMAGE := esp32-streamline-analysis
PROJECT ?= codec-scan
PROJECT_DIR := device/esp32/$(PROJECT)
PORT ?= /dev/cu.usbserial-0001

.PHONY: docker-image analysis-image analyze-capture build codec-scan audio-level stream flash monitor format lint test clean

docker-image:
	docker build -f dev.Dockerfile -t $(PIO_IMAGE) .

analysis-image:
	docker build -f analysis.Dockerfile -t $(ANALYSIS_IMAGE) .

analyze-capture: analysis-image
	@test -n "$(REF)" || (echo "REF=/path/to/reference.flac is required" >&2; exit 2)
	@test -n "$(CAP)" || (echo "CAP=/path/to/capture.wav is required" >&2; exit 2)
	docker run --rm \
		-v "$(PWD):/workspace" \
		-v "$(HOME):$(HOME):ro" \
		-v /tmp:/tmp \
		-w /workspace \
		$(ANALYSIS_IMAGE) \
		python3 tools/analyze_capture.py --reference "$(REF)" --capture "$(CAP)"

build codec-scan: docker-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-e PLATFORMIO_CORE_DIR=/workspace/.platformio-home \
		-w /workspace/$(PROJECT_DIR) \
		$(PIO_IMAGE) \
		pio run

audio-level:
	$(MAKE) build PROJECT=audio-level

stream:
	$(MAKE) build PROJECT=stream

format: docker-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-w /workspace \
		$(PIO_IMAGE) \
		sh -c 'ruff check --select I --fix bridge/http-wav tools && ruff format bridge/http-wav tools && clang-format -i device/esp32/*/src/main.cpp'

lint: docker-image analysis-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-w /workspace \
		$(PIO_IMAGE) \
		sh -c 'ruff format --check bridge/http-wav tools && clang-format --dry-run --Werror device/esp32/*/src/main.cpp && ruff check bridge/http-wav tools && mypy'
	docker run --rm \
		-v "$(PWD):/workspace" \
		-w /workspace \
		$(ANALYSIS_IMAGE) \
		mypy --strict tools/analyze_capture.py

test: docker-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-e PYTHONDONTWRITEBYTECODE=1 \
		-w /workspace/bridge/http-wav \
		$(PIO_IMAGE) \
		python3 -m unittest discover -s tests -v
	$(MAKE) codec-scan
	$(MAKE) audio-level
	$(MAKE) stream

flash:
	esptool --chip esp32 --port $(PORT) --baud 460800 write-flash \
		0x1000 $(PROJECT_DIR)/.pio/build/$(PROJECT)/bootloader.bin \
		0x8000 $(PROJECT_DIR)/.pio/build/$(PROJECT)/partitions.bin \
		0x10000 $(PROJECT_DIR)/.pio/build/$(PROJECT)/firmware.bin

monitor:
	esptool --port $(PORT) run
	screen $(PORT) 115200

clean: docker-image
	docker run --rm \
		-v "$(PWD):/workspace" \
		-e PLATFORMIO_CORE_DIR=/workspace/.platformio-home \
		-w /workspace/$(PROJECT_DIR) \
		$(PIO_IMAGE) \
		pio run -t clean
