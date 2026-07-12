include ../mk/common.mk

IMAGE := esp32-streamline-tools
DEV_IMAGE := esp32-streamline-tools-dev
LOCK_IMAGE := esp32-streamline-tools-lock
QEMU_IMAGE := esp32-streamline-tools-qemu
REF ?=
CAP ?=

# Smoke-harness inputs: the QEMU variant image for the emulated run; the
# serial port and device address for the hardware run. DEVICE resolves from
# the root .env when present, else stays empty and the hardware run skips API
# checks.
FLASH_IMAGE ?= $(REPO_ROOT)/dist/firmware/streamline-qemu-full.bin
PORT ?= /dev/cu.usbserial-0001
DEVICE ?= $(call dotenv,STREAMLINE_DEVICE)

# Run a check in the tools image with the source mounted and the shared
# ruff/mypy cache volume attached.
CONTAINER_RUN := $(CONTAINER) run --rm \
	-v "$(CURDIR):/workspace" -v "$(PYTHON_CACHE_VOLUME):/cache" \
	-e RUFF_CACHE_DIR=/cache/ruff-tools -e MYPY_CACHE_DIR=/cache/mypy-tools \
	-w /workspace $(DEV_IMAGE)
LOCK_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-v "$(CURDIR):/workspace" -e UV_CACHE_DIR=/tmp/uv-cache \
	-w /workspace $(LOCK_IMAGE) uv

# Mount only the directories holding the two input files, read-only, at their
# host paths so the arguments pass through unchanged. `sort` deduplicates when
# both files share a directory.
INPUT_DIRS = $(sort $(dir $(abspath $(REF))) $(dir $(abspath $(CAP))))
INPUT_MOUNTS = $(foreach d,$(INPUT_DIRS),-v "$(d):$(d):ro")

.PHONY: lock-image dev-image image qemu-image format lint lock lock-upgrade lock-check test analyze smoke-qemu smoke-device release-prepare

lock-image:
	$(CONTAINER) build -f Dockerfile --target lock-tool -t $(LOCK_IMAGE) .

lock: lock-image
	$(LOCK_RUN) lock

lock-upgrade: lock-image
	$(LOCK_RUN) lock --upgrade

lock-check: lock-image
	$(LOCK_RUN) lock --check

dev-image:
	$(CONTAINER) build -f Dockerfile --target development -t $(DEV_IMAGE) .

image:
	$(CONTAINER) build -f Dockerfile -t $(IMAGE) .

format: dev-image
	$(CONTAINER_RUN) sh -c 'ruff check --select I --fix src tests smoke && ruff format src tests smoke'

lint: dev-image
	$(CONTAINER_RUN) sh -c 'ruff format --check src tests smoke && ruff check src tests smoke && mypy'

test: dev-image
	$(CONTAINER_RUN) sh -c 'PYTHONPATH=/workspace/src python3 -m unittest discover -s tests -v'

analyze: image
	@test -n "$(REF)" || (echo "REF=/path/to/reference.flac is required" >&2; exit 2)
	@test -n "$(CAP)" || (echo "CAP=/path/to/capture.wav is required" >&2; exit 2)
	$(CONTAINER) run --rm $(INPUT_MOUNTS) $(IMAGE) \
		streamline-analyze --reference "$(abspath $(REF))" --capture "$(abspath $(CAP))"

qemu-image:
	$(CONTAINER) build -f Dockerfile --target qemu-runner -t $(QEMU_IMAGE) .

# Run the emulated-device pytest suite against the QEMU image variant: boot
# transcript, HTTP API over the emulated network, and the commissioning
# persistence cycle. Build the image first: `make -C firmware qemu-artifacts`.
smoke-qemu: qemu-image
	@test -f "$(FLASH_IMAGE)" || (echo "FLASH_IMAGE=$(FLASH_IMAGE) not found; build it with: make -C firmware qemu-artifacts" >&2; exit 2)
	$(CONTAINER) run --rm -v "$(abspath $(FLASH_IMAGE)):/flash.bin:ro" \
		-v "$(CURDIR):/workspace" -w /workspace \
		-e PYTHONPATH=/workspace/src -e STREAMLINE_QEMU_IMAGE=/flash.bin \
		$(QEMU_IMAGE) pytest smoke -v

# Reset the USB-connected board, sanity-check its boot over serial, then its
# HTTP API. Serial and espflash are host resources, so this runs the module
# with the system python3, like `make firmware-capture`.
smoke-device:
	PYTHONPATH=src python3 -m streamline_tools.smoke device --port "$(PORT)" \
		$(if $(DEVICE),--url "http://$(DEVICE)")

release-prepare: image
	@test -n "$(VERSION)" || (echo "VERSION is required" >&2; exit 2)
	$(CONTAINER) run --rm -v "$(REPO_ROOT)":/repo -w /repo \
		-u $(shell id -u):$(shell id -g) -e HOME=/tmp $(IMAGE) \
		python3 -m streamline_tools.release --root /repo --version "$(VERSION)"
