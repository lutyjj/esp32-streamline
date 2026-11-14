include ../mk/common.mk

IMAGE := esp32-streamline-tools
DEV_IMAGE := esp32-streamline-tools-dev
LOCK_IMAGE := esp32-streamline-tools-lock
QEMU_IMAGE := esp32-streamline-tools-qemu
REF ?=
CAP ?=

# Without DEVICE the hardware run skips the API suite. The admin key streams over
# container stdin, so it never appears in output, arguments or container metadata.
FLASH_IMAGE ?= $(REPO_ROOT)/dist/firmware/streamline-qemu-full.bin
DEVICE ?= $(call dotenv,STREAMLINE_DEVICE)
# A bridge advertising on the device's network, as host:port, for the discovery test.
SMOKE_BRIDGE ?= $(call dotenv,STREAMLINE_SMOKE_BRIDGE)

CONTAINER_RUN := $(CONTAINER) run --rm \
	-v "$(CURDIR):/workspace" -v "$(REPO_ROOT):/repo:ro" -v "$(PYTHON_CACHE_VOLUME):/cache" \
	-e RUFF_CACHE_DIR=/cache/ruff-tools -e MYPY_CACHE_DIR=/cache/mypy-tools \
	-w /workspace $(DEV_IMAGE)
LOCK_RUN := $(CONTAINER) run --rm --user "$(shell id -u):$(shell id -g)" \
	-v "$(CURDIR):/workspace" -e UV_CACHE_DIR=/tmp/uv-cache \
	-w /workspace $(LOCK_IMAGE) uv

# Mounts each input's directory read-only at its host path, so arguments pass through.
INPUT_DIRS = $(sort $(dir $(abspath $(REF))) $(dir $(abspath $(CAP))))
INPUT_MOUNTS = $(foreach d,$(INPUT_DIRS),-v "$(d):$(d):ro")

.PHONY: lock-image dev-image image qemu-image format lint lock lock-upgrade lock-check test analyze pcap size-report smoke-qemu smoke-device

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
	$(CONTAINER) build -f Dockerfile --target runtime -t $(IMAGE) .

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

# tshark separates sender gaps from retransmissions and receiver backpressure.
pcap: image
	@test -f "$(CAP)" || (echo "CAP=/path/to/capture.pcap is required" >&2; exit 2)
	$(CONTAINER) run --rm $(INPUT_MOUNTS) $(IMAGE) \
		tshark -n -r "$(abspath $(CAP))" -q -z conv,tcp \
		-z 'io,stat,1,tcp.len>0,tcp.analysis.retransmission,tcp.analysis.duplicate_ack,tcp.analysis.zero_window'

size-report: image
	$(CONTAINER) run --rm -v "$(REPO_ROOT):/repo:ro" $(IMAGE) streamline-size-report

qemu-image:
	$(CONTAINER) build -f Dockerfile --target qemu-runner -t $(QEMU_IMAGE) .

OTA_IMAGE ?= $(REPO_ROOT)/dist/firmware/streamline-qemu-ota.bin
FAILURE_IMAGE ?= $(REPO_ROOT)/dist/firmware/streamline-qemu-fail-management-ota.bin
# Each test boots its own QEMU. Oversubscribing the host reproduces the "no healthy
# response" setup flake.
SMOKE_JOBS ?=
API_CONTRACT := $(REPO_ROOT)/docs/openapi.json
CONTRACT_MOUNT := -v "$(API_CONTRACT):/contract/openapi.json:ro" -e STREAMLINE_API_CONTRACT=/contract/openapi.json
smoke-qemu: qemu-image
	@test -f "$(FLASH_IMAGE)" || (echo "FLASH_IMAGE=$(FLASH_IMAGE) not found; build it with: make -C firmware qemu-artifacts" >&2; exit 2)
	@test -f "$(OTA_IMAGE)" || (echo "OTA_IMAGE=$(OTA_IMAGE) not found; build it with: make -C firmware qemu-artifacts" >&2; exit 2)
	@test -f "$(FAILURE_IMAGE)" || (echo "FAILURE_IMAGE=$(FAILURE_IMAGE) not found; build it with: make -C firmware qemu-artifacts" >&2; exit 2)
	mkdir -p .smoke-qemu
	$(CONTAINER) run --rm --user "$(CONTAINER_HOST_USER)" -e HOME=/tmp \
		-v "$(abspath $(FLASH_IMAGE)):/flash.bin:ro" \
		-v "$(abspath $(OTA_IMAGE)):/ota.bin:ro" \
		-v "$(abspath $(FAILURE_IMAGE)):/failure.bin:ro" \
		-v "$(CURDIR)/.smoke-qemu:/evidence" \
		-v "$(CURDIR):/workspace" -w /workspace $(CONTRACT_MOUNT) \
		-e PYTHONPATH=/workspace/src -e STREAMLINE_QEMU_IMAGE=/flash.bin \
		$(QEMU_IMAGE) pytest smoke -v $(if $(SMOKE_JOBS),-n $(SMOKE_JOBS)) \
			--basetemp=/evidence/pytest --root-logdir=/evidence/serial

# The boot capture runs on the host python3, which reaches the serial port.
# `--capture=sys` keeps pytest off fd 0, where the admin key arrives; fd-capture
# would null it and the authenticated tests would skip.
smoke-device: qemu-image
	PYTHONPATH=src python3 -m streamline_tools.smoke device $(if $(DEVICE),--url "http://$(DEVICE)")
	$(if $(DEVICE),@{ sed -n 's/^STREAMLINE_ADMIN_KEY=//p' "$(REPO_ROOT)/.env" 2>/dev/null || true; } | $(CONTAINER) run --rm -i \
		-v "$(CURDIR):/workspace" -w /workspace $(CONTRACT_MOUNT) \
		-e PYTHONPATH=/workspace/src -e STREAMLINE_SMOKE_TARGET="http://$(DEVICE)" \
		-e STREAMLINE_SMOKE_BRIDGE="$(SMOKE_BRIDGE)" -e STREAMLINE_ADMIN_KEY_FD=0 \
		$(QEMU_IMAGE) pytest smoke -v --capture=sys,@echo "DEVICE is unset: skipping the API contract suite")
