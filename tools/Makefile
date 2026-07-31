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
# checks. The hardware admin key streams from the root .env over container
# stdin, so it never appears in Make output, process arguments, or container
# metadata; without it those dual-target tests skip.
FLASH_IMAGE ?= $(REPO_ROOT)/dist/firmware/streamline-qemu-full.bin
PORT ?= /dev/cu.usbserial-0001
DEVICE ?= $(call dotenv,STREAMLINE_DEVICE)

# Run a check in the tools image with the source mounted and the shared
# ruff/mypy cache volume attached.
CONTAINER_RUN := $(CONTAINER) run --rm \
	-v "$(CURDIR):/workspace" -v "$(REPO_ROOT):/repo:ro" -v "$(PYTHON_CACHE_VOLUME):/cache" \
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

.PHONY: lock-image dev-image image qemu-image format lint lock lock-upgrade lock-check test analyze size-report smoke-qemu smoke-device

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

# Attribute the built firmware ELF's flash bytes to ESP-IDF components, radio
# blobs, and Rust crates (issue #355), reading the firmware build tree through
# a read-only /repo mount. `make firmware-size-report` builds the ELF first
# and forwards here.
size-report: image
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" $(IMAGE) streamline-size-report

qemu-image:
	$(CONTAINER) build -f Dockerfile --target qemu-runner -t $(QEMU_IMAGE) .

# Run the emulated-device pytest suite against the QEMU image variant: boot,
# API over the emulated network, provisioning persistence, key gating,
# factory reset, and the OTA slot switch. Build the images first:
# `make -C firmware qemu-artifacts`. The OTA image is optional; without it
# the OTA test skips.
OTA_IMAGE ?= $(REPO_ROOT)/dist/firmware/streamline-qemu-ota.bin
# Parallel pytest-xdist workers for the emulated suite. Each test boots its
# own QEMU, so the suite parallelizes cleanly; bound the count to what the
# host can spare, because oversubscription reproduces the "no healthy
# response" setup flake. Empty runs serially, which is what CI uses.
SMOKE_JOBS ?=
smoke-qemu: qemu-image
	@test -f "$(FLASH_IMAGE)" || (echo "FLASH_IMAGE=$(FLASH_IMAGE) not found; build it with: make -C firmware qemu-artifacts" >&2; exit 2)
	$(CONTAINER) run --rm -v "$(abspath $(FLASH_IMAGE)):/flash.bin:ro" \
		$(if $(wildcard $(OTA_IMAGE)),-v "$(abspath $(OTA_IMAGE)):/ota.bin:ro" -e STREAMLINE_QEMU_OTA_IMAGE=/ota.bin) \
		-v "$(CURDIR):/workspace" -w /workspace \
		-e PYTHONPATH=/workspace/src -e STREAMLINE_QEMU_IMAGE=/flash.bin \
		$(QEMU_IMAGE) pytest smoke -v $(if $(SMOKE_JOBS),-n $(SMOKE_JOBS))

# Reset the USB-connected board, sanity-check its boot over serial, then run
# the same device-agnostic API suite the QEMU run uses against the live
# board. Serial and espflash are host resources, so the boot capture runs
# with the system python3, like `make firmware-capture`; the API suite runs
# in the pytest runner image and skips emulated-only tests.
smoke-device: qemu-image
	PYTHONPATH=src python3 -m streamline_tools.smoke device --port "$(PORT)" \
		$(if $(DEVICE),--url "http://$(DEVICE)")
	$(if $(DEVICE),@{ sed -n 's/^STREAMLINE_ADMIN_KEY=//p' "$(REPO_ROOT)/.env" 2>/dev/null || true; } | $(CONTAINER) run --rm -i \
		-v "$(CURDIR):/workspace" -w /workspace \
		-e PYTHONPATH=/workspace/src -e STREAMLINE_SMOKE_TARGET="http://$(DEVICE)" \
		-e STREAMLINE_ADMIN_KEY_FD=0 \
		$(QEMU_IMAGE) pytest smoke -v,@echo "DEVICE is unset: skipping the API contract suite")
